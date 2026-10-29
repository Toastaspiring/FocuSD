use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::Path,
    process::Command,
    sync::{mpsc, Arc, Mutex, OnceLock},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use windows::{
    core::Interface,
    ApplicationModel::AppInfo,
    Foundation::Size,
    Storage::Streams::{DataReader, IInputStream},
    Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
    UI::Notifications::{
        KnownNotificationBindings,
        Management::{UserNotificationListener, UserNotificationListenerAccessStatus},
        NotificationKinds, UserNotification,
    },
};

const EVENT_NAME: &str = "qq-notifications-changed";
const MAX_ITEMS: usize = 20;
const DIAGNOSTIC_TITLE: &str = "FocuSD QQ 通知诊断";
const DIAGNOSTIC_BODY: &str = "这是本机通道测试，不是聊天消息。";
static SERVICE: OnceLock<Arc<NotificationService>> = OnceLock::new();
static ICON_CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QQNotification {
    id: String,
    app_id: String,
    app: String,
    icon: Option<String>,
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
        // The first poll shows whatever is already in the notification hub, but
        // must not pop a "new message" preview for those pre-existing items.
        let first_sync = self.baseline.is_none();
        let previous = self.baseline.take().unwrap_or_default();
        let mut newest = None;
        for item in &current {
            if previous.get(&item.id) != Some(item) {
                self.items.retain(|existing| existing.id != item.id);
                self.items.insert(0, item.clone());
                self.items.truncate(MAX_ITEMS);
                if !first_sync {
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

pub(crate) fn diagnostic_state() -> Result<serde_json::Value, String> {
    let state = service()?.state.lock().map_err(|_| "QQ 通知状态不可用。")?;
    Ok(notification_diagnostics(&state.snapshot))
}

fn notification_diagnostics(snapshot: &NotificationSnapshot) -> serde_json::Value {
    serde_json::json!({
        "enabled": snapshot.enabled,
        "status": snapshot.status,
        "error": snapshot.error,
        "itemCount": snapshot.items.len(),
    })
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
        let operation = (|| {
            let listener = UserNotificationListener::Current()?;
            let access = listener.GetAccessStatus()?;
            let operation = if access == UserNotificationListenerAccessStatus::Unspecified {
                Some(listener.RequestAccessAsync()?)
            } else {
                None
            };
            windows::core::Result::Ok((access, operation))
        })();
        let _ = sender.send(operation);
    })
    .map_err(|error| format!("无法发起通知授权：{error}"))?;
    let (access, operation) =
        tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(5)))
            .await
            .map_err(|error| format!("通知授权线程失败：{error}"))?
            .map_err(|error| format!("无法发起通知授权：{error}"))?
            .map_err(|error| format!("无法请求 Windows 通知权限：{error}"))?;
    let access = match operation {
        Some(operation) => operation
            .await
            .map_err(|error| format!("Windows 通知授权失败：{error}"))?,
        None => access,
    };
    let _ = service()?.wake.try_send(());
    Ok(match access {
        UserNotificationListenerAccessStatus::Allowed => "allowed",
        UserNotificationListenerAccessStatus::Denied => "denied",
        _ => "unspecified",
    }
    .to_string())
}

#[tauri::command]
pub fn open_qq_notification_settings(app: AppHandle, access: bool) -> Result<(), String> {
    let url = if access {
        "ms-settings:privacy-notifications"
    } else {
        "ms-settings:notifications"
    };
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| format!("无法打开 Windows 通知设置：{error}"))
}

/// Opens a clicked notification. For a Chromium browser this replays Windows'
/// own deep-link activation (`--notification-launch-id`) so the exact page or
/// conversation opens in the right profile; otherwise it focuses the sending
/// app's window, launching it only when none is open.
#[tauri::command]
pub fn open_notification(app: AppHandle, id: String, app_id: String) -> Result<(), String> {
    if let Some(exe) = crate::app_icon_source::target_exe_for_aumid(&app_id) {
        if is_chromium(&exe) {
            if let Some(launch) = db_id_from(&id)
                .and_then(|db_id| crate::notification_launch::launch_for_db_id(db_id))
                .map(|(_, launch)| launch)
                .filter(|launch| is_safe_launch(launch))
            {
                if Command::new(&exe)
                    .arg(format!("--notification-launch-id={launch}"))
                    .spawn()
                    .is_ok()
                {
                    return Ok(());
                }
            }
        }
        if crate::window_activation::activate_app_window(&exe) {
            return Ok(());
        }
    }
    let shortcut = crate::app_icon_source::launch_target_for_aumid(&app_id)
        .ok_or("No launcher found for this app.")?;
    app.opener()
        .open_path(shortcut.to_string_lossy().to_string(), None::<&str>)
        .map_err(|error| format!("Could not open the app: {error}"))
}

/// The middle field of a `{aumid}:{id}:{ticks}` notification id is the store's
/// `Notification.Id`.
fn db_id_from(id: &str) -> Option<i64> {
    let mut parts = id.rsplitn(3, ':');
    let _ticks = parts.next()?;
    parts.next()?.parse::<i64>().ok()
}

fn is_chromium(exe: &Path) -> bool {
    exe.file_name()
        .map(|name| name.to_ascii_lowercase())
        .is_some_and(|name| {
            matches!(
                name.to_string_lossy().as_ref(),
                "chrome.exe" | "msedge.exe" | "brave.exe"
            )
        })
}

fn is_safe_launch(launch: &str) -> bool {
    !launch.is_empty()
        && launch.len() <= 4096
        && !launch.starts_with('-')
        && !launch.chars().any(char::is_control)
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
    let app_info = notification.AppInfo()?;
    let aumid = app_info
        .AppUserModelId()
        .map(|value| value.to_string_lossy())
        .unwrap_or_default();
    let app = app_info
        .DisplayInfo()
        .and_then(|info| info.DisplayName())
        .map(|value| value.to_string_lossy())
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| friendly_app_label(&aumid));
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
        .unwrap_or_else(|| app.clone());
    let body = parts.iter().skip(1).cloned().collect::<Vec<_>>().join("\n");
    let icon = app_icon(&app_info, &aumid);
    Ok(Some(QQNotification {
        id: format!("{aumid}:{id}:{ticks}"),
        app_id: if aumid.is_empty() { app.clone() } else { aumid.clone() },
        icon,
        app: app.chars().take(80).collect(),
        title: title.chars().take(120).collect(),
        body: body.chars().take(1000).collect(),
        created_at: ticks / 10_000 - 11_644_473_600_000,
    }))
}

/// Returns the source app's logo as a base64 data URL, cached per AppUserModelId
/// since logos do not change between notifications.
fn app_icon(app_info: &AppInfo, aumid: &str) -> Option<String> {
    if aumid.is_empty() {
        return None;
    }
    let cache = ICON_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(guard) = cache.lock() {
        if let Some(cached) = guard.get(aumid) {
            return cached.clone();
        }
    }
    // Packaged apps expose a logo directly; plain Win32 apps (Chrome, Notion,
    // classic Outlook, …) don't, so fall back to their Start Menu shortcut icon.
    let icon = read_app_logo(app_info).or_else(|| {
        crate::app_icon_source::icon_png_for_aumid(aumid)
            .map(|png| format!("data:image/png;base64,{}", STANDARD.encode(&png)))
    });
    if let Ok(mut guard) = cache.lock() {
        guard.insert(aumid.to_string(), icon.clone());
    }
    icon
}

fn read_app_logo(app_info: &AppInfo) -> Option<String> {
    let reference = app_info
        .DisplayInfo()
        .ok()?
        .GetLogo(Size {
            Width: 48.0,
            Height: 48.0,
        })
        .ok()?;
    let stream = pollster::block_on(reference.OpenReadAsync().ok()?).ok()?;
    let size = stream.Size().ok()?;
    if size == 0 || size > 1_000_000 {
        return None;
    }
    let input: IInputStream = stream.cast().ok()?;
    let reader = DataReader::CreateDataReader(&input).ok()?;
    let loaded = pollster::block_on(reader.LoadAsync(size as u32).ok()?).ok()?;
    let mut buffer = vec![0u8; loaded as usize];
    reader.ReadBytes(&mut buffer).ok()?;
    if buffer.is_empty() {
        return None;
    }
    // Packaged logos ship with heavy transparent padding; trim it so the glyph
    // fills the icon box instead of shrinking to a dot.
    if let Some(trimmed) = crate::app_icon_source::trim_png_bytes(&buffer) {
        return Some(format!("data:image/png;base64,{}", STANDARD.encode(&trimmed)));
    }
    let mime = if buffer.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else {
        "image/png"
    };
    Some(format!("data:{mime};base64,{}", STANDARD.encode(&buffer)))
}

/// Turns a raw AppUserModelId into a short, human-friendly app label when the
/// notification platform does not provide a display name.
fn friendly_app_label(aumid: &str) -> String {
    let trimmed = aumid.trim();
    if trimmed.is_empty() {
        return "App".to_string();
    }
    // Packaged apps use "Family!AppId"; take the family name's last segment.
    let family = trimmed.split('!').next().unwrap_or(trimmed);
    let candidate = family
        .rsplit(['.', '\\', '/'])
        .find(|segment| !segment.trim().is_empty())
        .unwrap_or(family);
    let candidate = candidate.strip_suffix(".exe").unwrap_or(candidate);
    if candidate.is_empty() {
        return trimmed.to_string();
    }
    let mut chars = candidate.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => trimmed.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostic_reports_never_include_chat_content() {
        let snapshot = NotificationSnapshot {
            items: vec![QQNotification {
                id: "private-id".into(),
                app_id: "private-app-id".into(),
                app: "private-app".into(),
                icon: None,
                title: "private-sender".into(),
                body: "private-message".into(),
                created_at: 123,
            }],
            ..Default::default()
        };
        let report = notification_diagnostics(&snapshot);
        assert_eq!(report["itemCount"], 1);
        assert!(!report.to_string().contains("private-"));
        assert!(report.get("items").is_none());
    }

    fn notice(id: u32, body: &str) -> QQNotification {
        QQNotification {
            id: id.to_string(),
            app_id: "App".into(),
            app: "App".into(),
            icon: None,
            title: "QQ".into(),
            body: body.into(),
            created_at: id as i64,
        }
    }
    #[test]
    fn startup_shows_existing_without_popping_and_new_messages_are_deduplicated() {
        let mut buffer = NotificationBuffer::default();
        // Items already in the hub are shown in the panel but never pop a preview.
        assert_eq!(buffer.sync(vec![notice(1, "existing")]), None);
        assert_eq!(buffer.items, vec![notice(1, "existing")]);
        let current = vec![notice(1, "existing"), notice(2, "new")];
        assert_eq!(buffer.sync(current.clone()), Some("2".into()));
        assert_eq!(buffer.sync(current), None);
        assert_eq!(buffer.items, vec![notice(2, "new"), notice(1, "existing")]);
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
    #[ignore = "Requires a real Windows system notification on this account"]
    fn reads_a_real_system_notification() {
        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        loop {
            let (status, items) =
                read_notifications().expect("Windows notifications must be readable");
            assert_eq!(status, NotificationStatus::Listening);
            if !items.is_empty() {
                assert!(items
                    .iter()
                    .all(|item| !item.app_id.is_empty() && !item.title.is_empty()));
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "Receive a real system notification during this test"
            );
            thread::sleep(Duration::from_secs(1));
        }
    }
}
