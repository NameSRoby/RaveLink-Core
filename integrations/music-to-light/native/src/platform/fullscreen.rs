//! Foreground fullscreen selection uses client-area coverage, so a maximized
//! titled window is not mistaken for a borderless fullscreen application.
use crate::Failure;
use windows::Win32::{
    Foundation::{POINT, RECT},
    Graphics::Gdi::{
        ClientToScreen, GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONULL,
    },
    UI::{
        HiDpi::{SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2},
        WindowsAndMessaging::{
            GetClientRect, GetDesktopWindow, GetForegroundWindow, GetShellWindow,
            GetWindowThreadProcessId, IsIconic, IsWindowVisible,
        },
    },
};
fn covers(client: RECT, display: RECT) -> bool {
    (client.left - display.left).abs() <= 2
        && (client.top - display.top).abs() <= 2
        && (client.right - display.right).abs() <= 2
        && (client.bottom - display.bottom).abs() <= 2
        && display.right > display.left
        && display.bottom > display.top
}
pub fn foreground_pid() -> Result<u32, Failure> {
    let previous =
        unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    let result = (|| {
        let window = unsafe { GetForegroundWindow() };
        if window.0.is_null()
            || window == unsafe { GetDesktopWindow() }
            || window == unsafe { GetShellWindow() }
            || unsafe { IsIconic(window) }.as_bool()
            || !unsafe { IsWindowVisible(window) }.as_bool()
        {
            return Err(Failure::new("fullscreen_app_unavailable"));
        }
        let mut client = RECT::default();
        unsafe {
            GetClientRect(window, &mut client)?;
        }
        let mut origin = POINT {
            x: client.left,
            y: client.top,
        };
        let mut edge = POINT {
            x: client.right,
            y: client.bottom,
        };
        unsafe {
            ClientToScreen(window, &mut origin).ok()?;
            ClientToScreen(window, &mut edge).ok()?;
        }
        let monitor = unsafe { MonitorFromWindow(window, MONITOR_DEFAULTTONULL) };
        if monitor.0.is_null() {
            return Err(Failure::new("fullscreen_app_unavailable"));
        }
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        unsafe {
            GetMonitorInfoW(monitor, &mut info).ok()?;
        }
        if !covers(
            RECT {
                left: origin.x,
                top: origin.y,
                right: edge.x,
                bottom: edge.y,
            },
            info.rcMonitor,
        ) {
            return Err(Failure::new("fullscreen_app_unavailable"));
        }
        let mut pid = 0;
        unsafe {
            GetWindowThreadProcessId(window, Some(&mut pid));
        }
        if pid == 0 {
            return Err(Failure::new("fullscreen_app_unavailable"));
        }
        Ok(pid)
    })();
    if !previous.0.is_null() {
        unsafe {
            SetThreadDpiAwarenessContext(previous);
        }
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn coverage_distinguishes_fullscreen_from_maximized_and_windowed() {
        let monitor = RECT {
            left: -1920,
            top: 0,
            right: 0,
            bottom: 1080,
        };
        assert!(covers(monitor, monitor));
        assert!(!covers(RECT { top: 30, ..monitor }, monitor));
        assert!(!covers(
            RECT {
                bottom: 1040,
                ..monitor
            },
            monitor
        ));
        assert!(!covers(
            RECT {
                left: 0,
                top: 0,
                right: 1920,
                bottom: 1080
            },
            monitor
        ));
    }
}
