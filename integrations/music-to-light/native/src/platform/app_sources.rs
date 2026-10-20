//! Private Core-only app association metadata, not a browser/feature DTO.
//! Only audio-session processes and their ancestry are described. No command
//! lines, windows, microphone data or unrelated process inventory is emitted.
use super::sources::{self, Process};
use crate::Failure;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use windows::core::PWSTR;
use windows::Win32::{
    Foundation::{CloseHandle, HANDLE},
    Storage::Packaging::Appx::GetPackageFamilyName,
    System::Diagnostics::ToolHelp::*,
};

struct Snapshot(HANDLE);
impl Drop for Snapshot {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}
fn parents() -> Result<BTreeMap<u32, u32>, Failure> {
    let snapshot = Snapshot(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)? });
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut result = BTreeMap::new();
    if unsafe { Process32FirstW(snapshot.0, &mut entry) }.is_ok() {
        loop {
            result.insert(entry.th32ProcessID, entry.th32ParentProcessID);
            if result.len() > 8192 {
                return Err(Failure::new("process_catalog_too_large"));
            }
            if unsafe { Process32NextW(snapshot.0, &mut entry) }.is_err() {
                break;
            }
        }
    }
    Ok(result)
}
fn family(process: &Process) -> String {
    let mut length = 0;
    unsafe {
        let _ = GetPackageFamilyName(process.handle, &mut length, None);
    }
    if length == 0 || length > 512 {
        return String::new();
    }
    let mut value = vec![0u16; length as usize];
    let status = unsafe {
        GetPackageFamilyName(process.handle, &mut length, Some(PWSTR(value.as_mut_ptr())))
    };
    if status.0 != 0 {
        return String::new();
    }
    let end = value.iter().position(|v| *v == 0).unwrap_or(value.len());
    String::from_utf16_lossy(&value[..end])
}
pub fn catalog() -> Result<Value, Failure> {
    let sources = sources::catalog()?;
    let parents = parents()?;
    let mut nodes = BTreeMap::new();
    for source in &sources {
        let Some(pid) = source["pid"].as_u64() else {
            continue;
        };
        let mut pid = pid as u32;
        let mut child_created = u64::MAX;
        for _ in 0..32 {
            if nodes.contains_key(&pid) {
                break;
            }
            let Ok(process) = Process::open(pid) else {
                break;
            };
            if process.created > child_created {
                break;
            }
            let Ok(image) = process.image_path() else {
                break;
            };
            if image.len() > 4096 {
                break;
            }
            let parent = *parents.get(&pid).unwrap_or(&0);
            nodes.insert(pid,json!({"pid":pid,"parent":parent,"created":process.created.to_string(),"image":image,"package":family(&process)}));
            child_created = process.created;
            if parent == 0 || parent == pid || nodes.len() >= 1024 {
                break;
            }
            pid = parent;
        }
    }
    Ok(
        json!({"v":2,"type":"app_catalog","sources":sources,"processes":nodes.into_values().collect::<Vec<_>>()}),
    )
}
