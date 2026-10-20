//! Audio capture proof. No network, file recording, lighting writes or autostart.
//! All data on stdout is versioned NDJSON; stderr never contains source identity.

#[cfg(test)]
mod analysis_tests;
mod cli;
mod clock;
mod levels;
mod onsets;
#[cfg(windows)]
mod platform;
mod spectrum;

use serde_json::{json, Value};
use std::io::{self, Write};

#[derive(Debug)]
pub struct Failure {
    code: &'static str,
    hresult: Option<i32>,
}

impl Failure {
    pub fn new(code: &'static str) -> Self {
        Self {
            code,
            hresult: None,
        }
    }
}

#[cfg(windows)]
impl From<windows::core::Error> for Failure {
    fn from(error: windows::core::Error) -> Self {
        Self {
            code: "windows_audio_error",
            hresult: Some(error.code().0),
        }
    }
}

/// Raw PCM and OS error strings never cross this boundary. A broken consumer is
/// an error, rather than a reason to retain or retry an unbounded output backlog.
pub fn emit(value: Value) -> Result<(), Failure> {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    serde_json::to_writer(&mut out, &value).map_err(|_| Failure::new("output_closed"))?;
    out.write_all(b"\n")
        .and_then(|_| out.flush())
        .map_err(|_| Failure::new("output_closed"))
}

fn run() -> Result<(), Failure> {
    let command = cli::parse(std::env::args().skip(1).collect())?;
    #[cfg(windows)]
    return platform::run(command);
    #[cfg(not(windows))]
    {
        let _ = command;
        Err(Failure::new("windows_required"))
    }
}

fn main() {
    if let Err(error) = run() {
        let _ = emit(json!({"v":2,"type":"error","code":error.code,"hresult":error.hresult}));
        std::process::exit(1);
    }
}
