//! Read-only Windows mixer telemetry. Unknown/mixed routes stay unknown.
use super::sources;
use crate::{cli::Source, Failure};
use serde_json::{json, Value};
use windows::core::Interface;
use windows::Win32::{
    Media::Audio::{Endpoints::IAudioEndpointVolume, *},
    System::Com::CLSCTX_ALL,
};

pub fn read(source: &Source) -> Result<Value, Failure> {
    let devices = sources::enumerator()?;
    let endpoints = unsafe { devices.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)? };
    let parents = super::app_sources::parents()?;
    let mut matches = Vec::new();
    if let Source::Process { pid, created } = source {
        for index in 0..unsafe { endpoints.GetCount()? }.min(64) {
            let device = unsafe { endpoints.Item(index)? };
            let manager: IAudioSessionManager2 = unsafe { device.Activate(CLSCTX_ALL, None)? };
            let sessions = unsafe { manager.GetSessionEnumerator()? };
            for i in 0..unsafe { sessions.GetCount()? }.min(128) {
                let control: IAudioSessionControl2 = unsafe { sessions.GetSession(i)? }.cast()?;
                if unsafe { control.GetState()? } != AudioSessionStateActive {
                    continue;
                }
                let mut candidate = unsafe { control.GetProcessId()? };
                let mut belongs = false;
                for _ in 0..32 {
                    if candidate == *pid {
                        belongs = true;
                        break;
                    }
                    let next = *parents.get(&candidate).unwrap_or(&0);
                    if next == 0 || next == candidate {
                        break;
                    }
                    candidate = next;
                }
                if !belongs {
                    continue;
                }
                let process = sources::Process::open(*pid)?;
                if process.created != *created {
                    return Err(Failure::new("source_exited"));
                }
                let volume: ISimpleAudioVolume = control.cast()?;
                matches.push((
                    device.clone(),
                    unsafe { volume.GetMasterVolume()? },
                    unsafe { volume.GetMute()? }.as_bool(),
                ));
            }
        }
        // Different sessions may have different gains. Do not guess an average.
        if matches.is_empty() {
            return Err(Failure::new("volume_unavailable"));
        }
        let first_id = sources::owned_text(unsafe { matches[0].0.GetId()? })?;
        for (device, gain, mute) in &matches {
            let id = sources::owned_text(unsafe { device.GetId()? })?;
            if id != first_id || (*gain - matches[0].1).abs() > 0.0001 || *mute != matches[0].2 {
                return Err(Failure::new("volume_ambiguous"));
            }
        }
    }
    let (device, gain, app_muted) = if let Some((device, gain, mute)) = matches.into_iter().next() {
        (device, Some(gain), mute)
    } else {
        let device = match source {
            Source::Output(id) => sources::output(Some(id))?,
            _ => sources::output(None)?,
        };
        (device, None, false)
    };
    let id = sources::owned_text(unsafe { device.GetId()? })?;
    let endpoint: IAudioEndpointVolume = unsafe { device.Activate(CLSCTX_ALL, None)? };
    let key = match source {
        Source::Process { pid, created } => format!("process:{pid}:{created}:{id}"),
        _ => format!("output:{id}"),
    };
    Ok(
        json!({"key":key,"systemPercent":unsafe { endpoint.GetMasterVolumeLevelScalar()? } * 100.0,
        "systemDb":unsafe { endpoint.GetMasterVolumeLevel()? }, "appGain":gain,
        "muted":app_muted || unsafe { endpoint.GetMute()? }.as_bool()}),
    )
}
