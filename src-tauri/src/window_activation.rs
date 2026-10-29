//! Brings an already-open window of a given executable to the foreground, so
//! clicking a notification focuses the running app instead of spawning a new
//! window (e.g. a second Chrome window).

use std::path::Path;
use windows::core::{BOOL, PWSTR};
use windows::Win32::{
    Foundation::{CloseHandle, HWND, LPARAM},
    System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    },
    UI::WindowsAndMessaging::{
        AllowSetForegroundWindow, EnumWindows, GetWindow, GetWindowTextLengthW,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetForegroundWindow, ShowWindow,
        GW_OWNER, SW_RESTORE,
    },
};

struct Search<'a> {
    exe: &'a Path,
    found: Option<HWND>,
}

/// Focuses an existing top-level window of `exe`. Returns false when none is open.
pub fn activate_app_window(exe: &Path) -> bool {
    if exe.as_os_str().is_empty() {
        return false;
    }
    let mut search = Search { exe, found: None };
    unsafe {
        let _ = EnumWindows(
            Some(enum_proc),
            LPARAM(&mut search as *mut Search as isize),
        );
        let Some(window) = search.found else {
            return false;
        };
        let mut process_id = 0u32;
        GetWindowThreadProcessId(window, Some(&mut process_id));
        let _ = AllowSetForegroundWindow(process_id);
        if IsIconic(window).as_bool() {
            let _ = ShowWindow(window, SW_RESTORE);
        }
        SetForegroundWindow(window).as_bool()
    }
}

unsafe extern "system" fn enum_proc(window: HWND, lparam: LPARAM) -> BOOL {
    let search = &mut *(lparam.0 as *mut Search);
    // Only real, visible, top-level app windows (titled, not owned/tool windows).
    if !IsWindowVisible(window).as_bool()
        || GetWindowTextLengthW(window) == 0
        || GetWindow(window, GW_OWNER).is_ok_and(|owner| !owner.is_invalid())
    {
        return true.into();
    }
    let mut process_id = 0u32;
    GetWindowThreadProcessId(window, Some(&mut process_id));
    if process_id == 0 {
        return true.into();
    }
    if let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) {
        let mut buffer = [0u16; 32768];
        let mut length = buffer.len() as u32;
        let resolved = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
        )
        .is_ok();
        let _ = CloseHandle(process);
        if resolved
            && String::from_utf16_lossy(&buffer[..length as usize])
                .eq_ignore_ascii_case(&search.exe.to_string_lossy())
        {
            search.found = Some(window);
            return false.into(); // stop enumerating
        }
    }
    true.into()
}
