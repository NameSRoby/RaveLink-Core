//! One bounded clock handshake on the private control pipe, then Stop on EOF
//! or another byte. The measurement thread never waits for a UI/network client.
use crate::{emit, Failure};
use serde::Deserialize;
use serde_json::json;
use std::{
    io::{BufRead, BufReader, Read},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SyncRequest {
    #[serde(rename = "type")]
    kind: String,
    generation: String,
    nonce: String,
}

fn qpc() -> Result<String, Failure> {
    let (mut ticks, mut frequency) = (0_i64, 0_i64);
    unsafe {
        QueryPerformanceCounter(&mut ticks)?;
        QueryPerformanceFrequency(&mut frequency)?;
    }
    if ticks < 0 || frequency <= 0 {
        return Err(Failure::new("clock_unavailable"));
    }
    Ok(((ticks as u128 * 10_000_000) / frequency as u128).to_string())
}

pub fn supervise(generation: String, stopped: Arc<AtomicBool>) {
    let result = (|| -> Result<(), Failure> {
        let mut input = BufReader::new(std::io::stdin());
        let mut line = Vec::with_capacity(513);
        let count = input
            .by_ref()
            .take(513)
            .read_until(b'\n', &mut line)
            .map_err(|_| Failure::new("control_closed"))?;
        if count == 0 {
            return Ok(());
        }
        if count > 512 || line.last() != Some(&b'\n') {
            return Err(Failure::new("invalid_clock_request"));
        }
        let request: SyncRequest =
            serde_json::from_slice(&line).map_err(|_| Failure::new("invalid_clock_request"))?;
        if request.kind != "sync"
            || request.generation != generation
            || request.nonce.len() != 32
            || !request.nonce.bytes().all(|v| v.is_ascii_hexdigit())
        {
            return Err(Failure::new("invalid_clock_request"));
        }
        emit(
            json!({"v":2,"type":"clock","generation":generation,"nonce":request.nonce,"qpc_100ns":qpc()?}),
        )?;
        let mut byte = [0];
        let _ = input.read(&mut byte);
        Ok(())
    })();
    if let Err(error) = result {
        let _ = emit(json!({"v":2,"type":"error","code":error.code,"hresult":error.hresult}));
    }
    stopped.store(true, Ordering::Release);
}
