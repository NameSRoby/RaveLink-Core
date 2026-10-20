//! Capture ownership and readiness. No signal inference from timers: packets
//! flagged SILENT contain measured zero; absent packets are waiting/stale.
use super::{activation, input};
use crate::{
    cli::Source,
    clock::SampleClock,
    emit,
    levels::{Levels, CHANNELS, FRAME_BYTES, RATE},
    Failure,
};
use serde_json::json;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};
use windows::Win32::Media::Audio::*;

struct Running(IAudioClient);
impl Drop for Running {
    fn drop(&mut self) {
        unsafe {
            let _ = self.0.Stop();
        }
    }
}
struct Packet<'a> {
    client: &'a IAudioCaptureClient,
    frames: u32,
}
impl Drop for Packet<'_> {
    fn drop(&mut self) {
        unsafe {
            let _ = self.client.ReleaseBuffer(self.frames);
        }
    }
}

pub fn run(source: Source, seconds: u32, generation: String) -> Result<(), Failure> {
    emit(
        json!({"v":2,"type":"hello","generation":generation,"scope":if matches!(source,Source::Process{..}|Source::FullscreenApp){"process_tree"}else{"entire_endpoint"},"max_seconds":seconds}),
    )?;
    // Fullscreen is a one-time selection gesture. Once selected, pin the exact
    // process identity just like named-app capture. Alt+Tab, minimization and
    // another fullscreen window must neither stop nor retarget this capture.
    let source = if matches!(source, Source::FullscreenApp) {
        let waiting = Instant::now();
        let selected = loop {
            if let Ok(pid) = super::fullscreen::foreground_pid() {
                break super::sources::Process::open(pid)?;
            }
            if waiting.elapsed() >= Duration::from_secs(5) {
                return Err(Failure::new("fullscreen_app_unavailable"));
            }
            thread::sleep(Duration::from_millis(50));
        };
        Source::Process {
            pid: selected.pid,
            created: selected.created,
        }
    } else {
        source
    };
    let (client, process) = activation::client(&source)?;
    let format = WAVEFORMATEX {
        wFormatTag: 3,
        nChannels: CHANNELS as u16,
        nSamplesPerSec: RATE,
        nAvgBytesPerSec: RATE * FRAME_BYTES as u32,
        nBlockAlign: FRAME_BYTES as u16,
        wBitsPerSample: 32,
        cbSize: 0,
    };
    unsafe {
        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK
                | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
            1_000_000,
            0,
            &format,
            None,
        )?;
    }
    let capture: IAudioCaptureClient = unsafe { client.GetService()? };
    let max_frames = unsafe { client.GetBufferSize()? };
    if max_frames > RATE / 4 {
        return Err(Failure::new("capture_buffer_exceeds_budget"));
    }
    let stopped = Arc::new(AtomicBool::new(false));
    let input_stopped = stopped.clone();
    // The parent can request one clock sample, then EOF/another byte means Stop.
    let input_generation = generation.clone();
    thread::spawn(move || input::supervise(input_generation, input_stopped));
    unsafe {
        client.Start()?;
    }
    let _running = Running(client);
    let began = Instant::now();
    let mut last_sample = None;
    let mut last_status = Instant::now();
    let mut analyzer = Levels::new();
    let mut clock = SampleClock::new();
    let mut packets = 0_u64;
    let mut frames = 0_u64;
    let mut discontinuities = 0_u64;
    emit(
        json!({"v":2,"type":"ready","generation":generation,"format":{"encoding":"f32le","sample_rate":RATE,"channels":CHANNELS,"frame_bytes":FRAME_BYTES,"window_frames":960,"analysis":{"fft_size":2048,"hop_frames":960,"band_edges_hz":[20,250,4000,20000],"window":"hann","flux":"positive_magnitude_difference","onset_refractory_frames":5760}},"signal":"waiting"}),
    )?;
    let mut reason = "duration";
    // Zero is parent-owned; EOF, Stop, source exit and failures still end capture.
    while seconds == 0 || began.elapsed() < Duration::from_secs(seconds as u64) {
        if stopped.load(Ordering::Acquire) {
            reason = "parent_stop";
            break;
        }
        if process.as_ref().is_some_and(|p| !p.alive()) {
            reason = "source_exited";
            break;
        }
        // Drain only a bounded number per turn so shutdown cannot starve under
        // sustained data. WASAPI itself owns the finite endpoint buffer.
        for _ in 0..32 {
            if unsafe { capture.GetNextPacketSize()? } == 0 {
                break;
            }
            let (mut data, mut count, mut flags, mut position, mut qpc) =
                (std::ptr::null_mut(), 0, 0, 0, 0);
            unsafe {
                capture.GetBuffer(
                    &mut data,
                    &mut count,
                    &mut flags,
                    Some(&mut position),
                    Some(&mut qpc),
                )?;
            }
            let packet = Packet {
                client: &capture,
                frames: count,
            };
            if count > max_frames || count > RATE / 4 {
                return Err(Failure::new("capture_packet_exceeds_budget"));
            }
            if count == 0 {
                drop(packet);
                break;
            }
            let timestamp_valid =
                flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32 == 0 && qpc > 0;
            let timestamp_gap =
                clock.observe(count, if timestamp_valid { Some(qpc) } else { None });
            let discontinuous =
                flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0 || timestamp_gap;
            let packet_first = frames;
            if packets == 0 || discontinuous {
                analyzer.reset(packet_first);
                if packets > 0 {
                    discontinuities += 1;
                }
            }
            let levels = if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 {
                analyzer.silence(count as usize)
            } else {
                if data.is_null() {
                    return Err(Failure::new("capture_packet_missing_data"));
                }
                analyzer
                    .push(unsafe { std::slice::from_raw_parts(data, count as usize * FRAME_BYTES) })
            };
            packets += 1;
            frames += count as u64;
            last_sample = Some(Instant::now());
            drop(packet); // Always release driver memory before stdout work.
            for level in levels {
                let qpc_end = if timestamp_valid {
                    Some(
                        (qpc + (level.end_frame.saturating_sub(packet_first)) * 10_000_000
                            / RATE as u64)
                            .to_string(),
                    )
                } else {
                    None
                };
                emit(
                    json!({"v":2,"type":"level","generation":generation,"sample_rate":RATE,"level":level,"qpc_end_100ns":qpc_end,"discontinuities":discontinuities}),
                )?;
            }
        }
        if last_status.elapsed() >= Duration::from_millis(250) {
            let age = last_sample.map(|at: Instant| at.elapsed().as_millis() as u64);
            emit(
                json!({"v":2,"type":"status","generation":generation,"signal":match age{None=>"waiting",Some(ms)if ms>750=>"stale",_=>"receiving"},"last_sample_age_ms":age}),
            )?;
            last_status = Instant::now();
        }
        thread::sleep(Duration::from_millis(5));
    }
    // Stop before announcing completion. RAII still stops on every early error.
    drop(_running);
    emit(
        json!({"v":2,"type":"ended","generation":generation,"reason":reason,"packets":packets,"frames":frames,"discontinuities":discontinuities}),
    )
}
