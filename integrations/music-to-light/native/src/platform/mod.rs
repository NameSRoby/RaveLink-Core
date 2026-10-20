//! COM stays on the capture thread. The helper is a separate, finite-lived
//! process, and no Windows interface is exported across its stdio boundary.
mod activation;
mod app_sources;
mod capture;
mod fullscreen;
mod input;
mod sources;

use crate::{cli::Command, emit, Failure};
use serde_json::json;
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

struct Apartment;
impl Apartment {
    fn enter() -> Result<Self, Failure> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
        }
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}

pub fn run(command: Command) -> Result<(), Failure> {
    let _apartment = Apartment::enter()?;
    match command {
        Command::Apps => emit(app_sources::catalog()?),
        Command::Sources => emit(
            json!({"v":2,"type":"sources","sources":sources::catalog()?,"process_loopback":"probed_on_start","minimum_process_build":20348}),
        ),
        Command::Identify(pid) => {
            let identity = sources::Process::open(pid)?;
            emit(json!({"v":2,"type":"source","source":identity.description()?}))
        }
        Command::Capture {
            source,
            seconds,
            generation,
        } => capture::run(source, seconds, generation),
    }
}
