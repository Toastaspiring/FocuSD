use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Command,
    sync::{mpsc, Arc, Mutex, OnceLock},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use windows::{
    core::{w, BOOL, PWSTR},
    Win32::{
        Foundation::{CloseHandle, HWND, LPARAM},
        System::{
            Registry::{RegGetValueW, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ},
            Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
            WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
        },
        UI::WindowsAndMessaging::{
            EnumWindows, GetWindow, GetWindowTextLengthW, GetWindowThreadProcessId,
            IsWindowVisible, SetForegroundWindow, ShowWindowAsync, GW_OWNER, SW_RESTORE,
        },
    },
    UI::Notifications::{
        KnownNotificationBindings,
        Management::{UserNotificationListener, UserNotificationListenerAccessStatus},
        NotificationKinds, UserNotification,
    },
};

const QQ_APP_ID: &str = "QQ";
const EVENT_NAME: &str = "qq-notifications-changed";
const MAX_ITEMS: usize = 20;
const DIAGNOSTIC_TITLE: &str = "FocuSD QQ 通知诊断";
const DIAGNOSTIC_BODY: &str = "这是本机通道测试，不是聊天消息。";
static SERVICE: OnceLock<Arc<NotificationService>> = OnceLock::new();

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QQNotification {
    id: String,
    title: String,
    body: String,
    created_at: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NotificationStatus {
    Disabled,
    Waiting,
    Listening,
    PermissionDenied,
    PermissionRequired,
    Error,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSnapshot {
    revision: u64,
    enabled: bool,
    status: NotificationStatus,
    items: Vec<QQNotification>,
    error: Option<String>,
}

impl Default for NotificationSnapshot {
    fn default() -> Self {
        Self {
            revision: 0,
            enabled: false,
            status: NotificationStatus::Disabled,
            items: Vec::new(),
            error: None,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NotificationEvent {
    snapshot: NotificationSnapshot,
    newest_id: Option<String>,
    window_visible: bool,
}

#[derive(Default)]
struct NotificationBuffer {
    baseline: Option<HashMap<String, QQNotification>>,
    items: Vec<QQNotification>,
}

impl NotificationBuffer {
    fn sync(&mut self, mut current: Vec<QQNotification>) -> Option<String> {
        current.sort_by_key(|item| item.created_at);
        let mut newest = None;
        if let Some(previous) = &self.baseline {
            for item in &current {
                if previous.get(&item.id) != Some(item) {
                    self.items.retain(|existing| existing.id != item.id);
                    self.items.insert(0, item.clone());
                    self.items.truncate(MAX_ITEMS);
                    newest = Some(item.id.clone());
                }
            }
        }
        self.baseline = Some(
            current
                .into_iter()
                .map(|item| (item.id.clone(), item))
                .collect(),
        );
        newest
    }
}

#[derive(Default)]
struct MonitorState {
    snapshot: NotificationSnapshot,
    generation: u64,
    buffer: NotificationBuffer,
}

struct NotificationService {
    app: AppHandle,
    state: Mutex<MonitorState>,
    wake: mpsc::SyncSender<()>,
}

pub fn init(app: &AppHandle) -> Result<(), String> {
    if SERVICE.get().is_some() {
        return Ok(());
    }
    let (wake, receiver) = mpsc::sync_channel(1);
    let service = Arc::new(NotificationService {
        app: app.clone(),
        state: Mutex::new(MonitorState::default()),
        wake,
    });
    SERVICE
        .set(service.clone())
        .map_err(|_| "QQ 通知服务已启动。".to_string())?;
    thread::Builder::new()
        .name("qq-notifications".into())
        .spawn(move || monitor(service, receiver))
        .map_err(|error| format!("无法启动 QQ 通知监听：{error}"))?;
    Ok(())
}

fn service() -> Result<&'static Arc<NotificationService>, String> {
    SERVICE
        .get()
        .ok_or_else(|| "QQ 通知服务尚未就绪。".to_string())
}

#[tauri::command]
pub fn get_qq_notification_state() -> Result<NotificationSnapshot, String> {
    Ok(service()?
        .state
        .lock()
        .map_err(|_| "QQ 通知状态不可用。")?
        .snapshot
        .clone())
}

#[tauri::command]
pub fn set_qq_notifications_enabled(enabled: bool) -> Result<NotificationSnapshot, String> {
    let service = service()?;
    let snapshot = {
        let mut state = service.state.lock().map_err(|_| "QQ 通知状态不可用。")?;
        if state.snapshot.enabled == enabled {
            return Ok(state.snapshot.clone());
        }
        state.generation += 1;
        state.buffer = NotificationBuffer::default();
        state.snapshot = NotificationSnapshot {
            revision: state.snapshot.revision + 1,
            enabled,
            status: if enabled {
                NotificationStatus::Waiting
            } else {
                NotificationStatus::Disabled
            },
            ..NotificationSnapshot::default()
        };
        state.snapshot.clone()
    };
    publish(service, snapshot.clone(), None);
    let _ = service.wake.try_send(());
    Ok(snapshot)
}

#[tauri::command]
pub fn clear_qq_notifications() -> Result<NotificationSnapshot, String> {
    let service = service()?;
    let snapshot = {
        let mut state = service.state.lock().map_err(|_| "QQ 通知状态不可用。")?;
        state.buffer.items.clear();
        state.snapshot.items.clear();
        state.snapshot.revision += 1;
        state.snapshot.clone()
    };
    publish(service, snapshot.clone(), None);
    Ok(snapshot)
}

#[tauri::command]
pub async fn request_qq_notification_access(app: AppHandle) -> Result<String, String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let operation =
            UserNotificationListener::Current().and_then(|listener| listener.RequestAccessAsync());
        let _ = sender.send(operation);
    })
    .map_err(|error| format!("无法发起通知授权：{error}"))?;
    let operation =
        tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(5)))
            .await
            .map_err(|error| format!("通知授权线程失败：{error}"))?
            .map_err(|error| format!("无法发起通知授权：{error}"))?
            .map_err(|error| format!("无法请求 Windows 通知权限：{error}"))?;
    let access = operation
        .await
        .map_err(|error| format!("Windows 通知授权失败：{error}"))?;
    Ok(match access {
        UserNotificationListenerAccessStatus::Allowed => "allowed",
        UserNotificationListenerAccessStatus::Denied => "denied",
        _ => "unspecified",
    }
    .to_string())
}

fn publish(
    service: &NotificationService,
    snapshot: NotificationSnapshot,
    newest_id: Option<String>,
) {
    let window_visible = service
        .app
        .get_webview_window("main")
        .is_some_and(|window| window.is_visible().unwrap_or(false));
    let _ = service.app.emit_to(
        "main",
        EVENT_NAME,
        NotificationEvent {
            snapshot,
            newest_id,
            window_visible,
        },
    );
}

fn monitor(service: Arc<NotificationService>, receiver: mpsc::Receiver<()>) {
    loop {
        let (enabled, generation) = match service.state.lock() {
            Ok(state) => (state.snapshot.enabled, state.generation),
            Err(_) => return,
        };
        if !enabled {
            if receiver.recv().is_err() {
                return;
            }
            continue;
        }
        let poll = read_notifications();
        let change = {
            let Ok(mut state) = service.state.lock() else {
                return;
            };
            if state.generation != generation || !state.snapshot.enabled {
                continue;
            }
            let before = state.snapshot.clone();
            let newest = match poll {
                Ok((NotificationStatus::Listening, current)) => {
                    state.snapshot.status = NotificationStatus::Listening;
                    state.snapshot.error = None;
                    let newest = state.buffer.sync(current);
                    state.snapshot.items = state.buffer.items.clone();
                    newest
                }
                Ok((status, _)) => {
                    state.buffer = NotificationBuffer::default();
                    state.snapshot.items.clear();
                    state.snapshot.status = status;
                    state.snapshot.error = None;
                    None
                }
                Err(error) => {
                    state.snapshot.status = NotificationStatus::Error;
                    state.snapshot.error = Some(error);
                    None
                }
            };
            if state.snapshot != before {
                state.snapshot.revision += 1;
                Some((state.snapshot.clone(), newest))
            } else {
                None
            }
        };
        if let Some((snapshot, newest)) = change {
            publish(&service, snapshot, newest);
        }
        if receiver.recv_timeout(Duration::from_secs(1))
            == Err(mpsc::RecvTimeoutError::Disconnected)
        {
            return;
        }
    }
}

struct WinRT;
impl Drop for WinRT {
    fn drop(&mut self) {
        unsafe { RoUninitialize() };
    }
}

fn read_notifications() -> Result<(NotificationStatus, Vec<QQNotification>), String> {
    unsafe { RoInitialize(RO_INIT_MULTITHREADED) }
        .map_err(|error| format!("无法初始化 Windows 通知：{error}"))?;
    let _apartment = WinRT;
    let listener = UserNotificationListener::Current()
        .map_err(|error| format!("Windows 通知监听不可用：{error}"))?;
    let access = listener
        .GetAccessStatus()
        .map_err(|error| format!("无法检查通知权限：{error}"))?;
    if access != UserNotificationListenerAccessStatus::Allowed {
        return Ok((
            if access == UserNotificationListenerAccessStatus::Denied {
                NotificationStatus::PermissionDenied
            } else {
                NotificationStatus::PermissionRequired
            },
            Vec::new(),
        ));
    }
    let operation = listener
        .GetNotificationsAsync(NotificationKinds::Toast)
        .map_err(|error| format!("无法读取 Windows 通知：{error}"))?;
    let notifications =
        pollster::block_on(operation).map_err(|error| format!("无法读取 Windows 通知：{error}"))?;
    let mut items = Vec::new();
    for notification in notifications {
        if let Ok(Some(item)) = read_qq_notification(&notification) {
            items.push(item);
        }
    }
    Ok((NotificationStatus::Listening, items))
}

fn read_qq_notification(
    notification: &UserNotification,
) -> windows::core::Result<Option<QQNotification>> {
    if notification.AppInfo()?.AppUserModelId()? != QQ_APP_ID {
        return Ok(None);
    }
    let id = notification.Id()?;
    let ticks = notification.CreationTime()?.UniversalTime;
    let mut parts = Vec::new();
    if let Ok(elements) = notification
        .Notification()?
        .Visual()?
        .GetBinding(&KnownNotificationBindings::ToastGeneric()?)
        .and_then(|binding| binding.GetTextElements())
    {
        for element in elements {
            if let Ok(text) = element.Text() {
                parts.push(text.to_string_lossy());
            }
        }
    }
    if parts.first().is_some_and(|title| title == DIAGNOSTIC_TITLE)
        && parts.iter().any(|body| body == DIAGNOSTIC_BODY)
    {
        return Ok(None);
    }
    if parts
        .first()
        .is_some_and(|title| title == "FocuSD QQ notification diagnostic")
        && parts
            .iter()
            .any(|body| body == "Local channel test; this is not a chat message.")
    {
        return Ok(None);
    }
    let title = parts
        .first()
        .filter(|text| !text.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| "QQ".into());
    let body = parts.iter().skip(1).cloned().collect::<Vec<_>>().join("\n");
    Ok(Some(QQNotification {
        id: format!("QQ:{id}:{ticks}"),
        title: title.chars().take(120).collect(),
        body: body.chars().take(1000).collect(),
        created_at: ticks / 10_000 - 11_644_473_600_000,
    }))
}

fn qq_executable() -> Result<PathBuf, String> {
    for root in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        for key in [
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ"),
            w!("Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ"),
        ] {
            let mut data = [0u16; 2048];
            let mut bytes = (data.len() * 2) as u32;
            let result = unsafe {
                RegGetValueW(
                    root,
                    key,
                    w!("DisplayIcon"),
                    RRF_RT_REG_SZ,
                    None,
                    Some(data.as_mut_ptr().cast()),
                    Some(&mut bytes),
                )
            };
            if result.is_ok() {
                let length = data.iter().position(|ch| *ch == 0).unwrap_or(data.len());
                let icon = String::from_utf16_lossy(&data[..length]);
                let executable = icon
                    .rsplit_once(',')
                    .filter(|(_, index)| index.trim().parse::<i32>().is_ok())
                    .map_or(icon.as_str(), |(path, _)| path)
                    .trim()
                    .trim_matches('"');
                let path = PathBuf::from(executable);
                if path.is_absolute()
                    && path.is_file()
                    && path
                        .file_name()
                        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("QQ.exe"))
                {
                    return Ok(path);
                }
            }
        }
    }
    Err("未找到 QQ 安装路径，请确认已安装 Windows 版 QQ。".into())
}

struct QQWindowSearch<'a> {
    executable: &'a Path,
    window: Option<HWND>,
}

unsafe extern "system" fn find_qq_window(window: HWND, context: LPARAM) -> BOOL {
    let search = &mut *(context.0 as *mut QQWindowSearch<'_>);
    if !IsWindowVisible(window).as_bool()
        || GetWindowTextLengthW(window) == 0
        || GetWindow(window, GW_OWNER).is_ok_and(|owner| !owner.is_invalid())
    {
        return true.into();
    }
    let mut process_id = 0;
    GetWindowThreadProcessId(window, Some(&mut process_id));
    if let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) {
        let mut path = [0u16; 32768];
        let mut length = path.len() as u32;
        let result = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(path.as_mut_ptr()),
            &mut length,
        );
        let _ = CloseHandle(process);
        if result.is_ok()
            && String::from_utf16_lossy(&path[..length as usize])
                .eq_ignore_ascii_case(&search.executable.to_string_lossy())
        {
            search.window = Some(window);
            return false.into();
        }
    }
    true.into()
}

#[tauri::command]
pub async fn open_qq() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let executable = qq_executable()?;
        let mut search = QQWindowSearch {
            executable: &executable,
            window: None,
        };
        unsafe {
            let _ = EnumWindows(
                Some(find_qq_window),
                LPARAM((&mut search as *mut QQWindowSearch<'_>) as isize),
            );
            if let Some(window) = search.window {
                let _ = ShowWindowAsync(window, SW_RESTORE);
                if SetForegroundWindow(window).as_bool() {
                    return Ok(());
                }
            }
        }
        Command::new(executable)
            .spawn()
            .map_err(|error| format!("无法打开 QQ：{error}"))?;
        Ok(())
    })
    .await
    .map_err(|error| format!("打开 QQ 的线程失败：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn notice(id: u32, body: &str) -> QQNotification {
        QQNotification {
            id: id.to_string(),
            title: "QQ".into(),
            body: body.into(),
            created_at: id as i64,
        }
    }
    #[test]
    fn startup_notifications_do_not_replay_and_new_messages_are_deduplicated() {
        let mut buffer = NotificationBuffer::default();
        assert_eq!(buffer.sync(vec![notice(1, "existing")]), None);
        assert!(buffer.items.is_empty());
        let current = vec![notice(1, "existing"), notice(2, "new")];
        assert_eq!(buffer.sync(current.clone()), Some("2".into()));
        assert_eq!(buffer.sync(current), None);
        assert_eq!(buffer.items, vec![notice(2, "new")]);
    }
    #[test]
    fn updated_notifications_replace_content_without_increasing_count() {
        let mut buffer = NotificationBuffer::default();
        buffer.sync(vec![]);
        buffer.sync(vec![notice(1, "first")]);
        assert_eq!(buffer.sync(vec![notice(1, "updated")]), Some("1".into()));
        assert_eq!(buffer.items, vec![notice(1, "updated")]);
    }
    #[test]
    fn clearing_history_does_not_redisplay_unchanged_system_notifications() {
        let mut buffer = NotificationBuffer::default();
        buffer.sync(vec![]);
        let current = vec![notice(1, "new")];
        buffer.sync(current.clone());
        buffer.items.clear();
        assert_eq!(buffer.sync(current), None);
        assert!(buffer.items.is_empty());
    }
    #[test]
    fn notification_history_is_bounded_and_keeps_latest_first() {
        let mut buffer = NotificationBuffer::default();
        buffer.sync(vec![]);
        buffer.sync((1..=25).map(|id| notice(id, "new")).collect());
        assert_eq!(buffer.items.len(), MAX_ITEMS);
        assert_eq!(buffer.items.first().unwrap().id, "25");
        assert_eq!(buffer.items.last().unwrap().id, "6");
    }

    #[test]
    #[ignore = "Requires a real QQ system notification on this Windows account"]
    fn reads_a_real_qq_system_notification() {
        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        loop {
            let (status, items) =
                read_notifications().expect("Windows notifications must be readable");
            assert_eq!(status, NotificationStatus::Listening);
            if !items.is_empty() {
                assert!(items
                    .iter()
                    .all(|item| item.id.starts_with("QQ:") && !item.title.is_empty()));
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "Receive a real QQ notification during this test"
            );
            thread::sleep(Duration::from_secs(1));
        }
    }
}
