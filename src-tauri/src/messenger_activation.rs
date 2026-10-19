use std::{thread, time::Duration};
use windows::Win32::{
    Foundation::{HWND, LPARAM, WPARAM},
    UI::WindowsAndMessaging::{
        GetForegroundWindow, IsIconic, IsWindowVisible, SendMessageTimeoutW, SetForegroundWindow,
        SC_RESTORE, SMTO_ABORTIFHUNG, SMTO_BLOCK, SMTO_ERRORONEXIT, WM_SYSCOMMAND,
    },
};

pub fn activate_existing_window(window: HWND, name: &str) -> Result<(), String> {
    unsafe {
        if !IsWindowVisible(window).as_bool() || IsIconic(window).as_bool() {
            // Let the client handle its normal Restore command before requesting focus.
            let sent = SendMessageTimeoutW(
                window,
                WM_SYSCOMMAND,
                WPARAM(SC_RESTORE as usize),
                LPARAM(0),
                SMTO_ABORTIFHUNG | SMTO_BLOCK | SMTO_ERRORONEXIT,
                1_000,
                None,
            );
            if sent.0 == 0 {
                return Err(format!(
                    "{name}没有响应窗口恢复请求，请从任务栏或托盘打开。"
                ));
            }
            for _ in 0..20 {
                if IsWindowVisible(window).as_bool() && !IsIconic(window).as_bool() {
                    break;
                }
                thread::sleep(Duration::from_millis(50));
            }
        }
        if IsWindowVisible(window).as_bool()
            && !IsIconic(window).as_bool()
            && (GetForegroundWindow() == window || SetForegroundWindow(window).as_bool())
        {
            return Ok(());
        }
    }
    Err(format!(
        "已找到{name}窗口，但未能切换到前台，请点击任务栏或托盘中的{name}。"
    ))
}
