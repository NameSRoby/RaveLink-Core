//! Enumerate real audio sessions; return executable basename, never window titles
//! or full executable paths. A process creation stamp prevents PID-reuse capture.
use crate::Failure;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use windows::core::{Interface, PWSTR};
use windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
use windows::Win32::{
    Devices::FunctionDiscovery::PKEY_Device_FriendlyName,
    Foundation::{CloseHandle, FILETIME, HANDLE, WAIT_TIMEOUT},
    Media::Audio::*,
    System::{
        Com::{
            CoCreateInstance, CoTaskMemFree,
            StructuredStorage::{PropVariantClear, PropVariantToStringAlloc},
            CLSCTX_ALL, STGM_READ,
        },
        Threading::{
            GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, WaitForSingleObject,
            PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        },
    },
};

pub struct Process {
    pub handle: HANDLE,
    pub pid: u32,
    pub created: u64,
}
impl Drop for Process {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}
impl Process {
    pub fn open(pid: u32) -> Result<Self, Failure> {
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                false,
                pid,
            )?
        };
        let mut result = Self {
            handle,
            pid,
            created: 0,
        };
        let (mut created, mut exit, mut kernel, mut user) = (
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
        );
        unsafe {
            GetProcessTimes(handle, &mut created, &mut exit, &mut kernel, &mut user)?;
        }
        result.created = ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64;
        if !result.alive() {
            return Err(Failure::new("source_exited"));
        }
        Ok(result)
    }
    pub fn alive(&self) -> bool {
        unsafe { WaitForSingleObject(self.handle, 0) == WAIT_TIMEOUT }
    }
    pub fn description(&self) -> Result<Value, Failure> {
        let path = self.image_path()?;
        let label = path.rsplit(['\\', '/']).next().unwrap_or("Application");
        Ok(
            json!({"id":format!("process:{}:{}",self.pid,self.created),"kind":"application","label":label,"pid":self.pid,"created":self.created.to_string(),"scope":"process_tree"}),
        )
    }
    pub fn image_path(&self) -> Result<String, Failure> {
        let mut name = vec![0_u16; 32768];
        let mut length = name.len() as u32;
        unsafe {
            QueryFullProcessImageNameW(
                self.handle,
                PROCESS_NAME_WIN32,
                PWSTR(name.as_mut_ptr()),
                &mut length,
            )?;
        }
        Ok(String::from_utf16_lossy(&name[..length as usize]))
    }
}

pub fn enumerator() -> Result<IMMDeviceEnumerator, Failure> {
    Ok(unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)? })
}

/// GetId/PropVariantToStringAlloc return COM allocations. Free them even if UTF16
/// conversion fails; no raw pointer survives this function.
pub fn owned_text(value: PWSTR) -> Result<String, Failure> {
    let text = unsafe { value.to_string() };
    unsafe {
        CoTaskMemFree(Some(value.0.cast()));
    }
    text.map_err(|_| Failure::new("invalid_source_label"))
}

fn endpoint_description(device: &IMMDevice, index: u32) -> Result<Value, Failure> {
    let id = owned_text(unsafe { device.GetId()? })?;
    let label = (|| -> Result<String, Failure> {
        let properties = unsafe { device.OpenPropertyStore(STGM_READ)? };
        let mut value = unsafe { properties.GetValue(&PKEY_Device_FriendlyName)? };
        let converted = unsafe { PropVariantToStringAlloc(&value) };
        unsafe {
            let _ = PropVariantClear(&mut value);
        }
        owned_text(converted?)
    })()
    .unwrap_or_else(|_| format!("Output device {}", index + 1));
    Ok(
        json!({"id":format!("output:{id}"),"kind":"output","label":label.chars().take(128).collect::<String>(),"scope":"entire_endpoint"}),
    )
}

pub fn catalog() -> Result<Vec<Value>, Failure> {
    let devices = unsafe { enumerator()?.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)? };
    let mut result = Vec::new();
    let mut seen = BTreeSet::new();
    for index in 0..unsafe { devices.GetCount()? }.min(64) {
        if result.len() >= 256 {
            break;
        }
        let device = unsafe { devices.Item(index)? };
        if let Ok(description) = endpoint_description(&device, index) {
            result.push(description);
        }
        let sessions = (|| -> Result<IAudioSessionEnumerator, Failure> {
            let manager: IAudioSessionManager2 = unsafe { device.Activate(CLSCTX_ALL, None)? };
            Ok(unsafe { manager.GetSessionEnumerator()? })
        })();
        let Ok(sessions) = sessions else { continue };
        for i in 0..unsafe { sessions.GetCount()? }.min(128) {
            if result.len() >= 256 {
                break;
            }
            let entry = (|| -> Result<Value, Failure> {
                let control: IAudioSessionControl2 = unsafe { sessions.GetSession(i)? }.cast()?;
                if unsafe { control.GetState()? } == AudioSessionStateExpired {
                    return Err(Failure::new("session_expired"));
                }
                let pid = unsafe { control.GetProcessId()? };
                let mut description = Process::open(pid)?.description()?;
                description["active"] =
                    json!(unsafe { control.GetState()? } == AudioSessionStateActive);
                let meter: Result<IAudioMeterInformation, _> = control.cast();
                description["peak"] = json!(meter
                    .and_then(|m| unsafe { m.GetPeakValue() })
                    .unwrap_or(0.0));
                Ok(description)
            })();
            if let Ok(entry) = entry {
                let id = entry["id"].as_str().unwrap_or_default().to_owned();
                if seen.insert(id) {
                    result.push(entry);
                } else if let Some(previous) = result.iter_mut().find(|r| r["id"] == entry["id"]) {
                    previous["active"] = json!(
                        previous["active"].as_bool().unwrap_or(false)
                            || entry["active"].as_bool().unwrap_or(false)
                    );
                    previous["peak"] = json!(previous["peak"]
                        .as_f64()
                        .unwrap_or(0.0)
                        .max(entry["peak"].as_f64().unwrap_or(0.0)));
                }
            }
        }
    }
    result.push(json!({"id":"default-output","kind":"output","label":"Current default output (all applications)","scope":"entire_endpoint"}));
    Ok(result)
}

/// Output capture is explicit. Only active render endpoints in the enumerated
/// collection are accepted; an arbitrary device ID cannot switch to a microphone.
pub fn output(id: Option<&str>) -> Result<IMMDevice, Failure> {
    let devices = enumerator()?;
    if id.is_none() {
        return Ok(unsafe { devices.GetDefaultAudioEndpoint(eRender, eConsole)? });
    }
    let active = unsafe { devices.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)? };
    for i in 0..unsafe { active.GetCount()? }.min(64) {
        let device = unsafe { active.Item(i)? };
        if owned_text(unsafe { device.GetId()? })? == id.unwrap() {
            return Ok(device);
        }
    }
    Err(Failure::new("output_source_unavailable"))
}
