use imap::{types::Flag, Session};
use keyring::{Entry, Error as KeyringError};
use mailparse::MailHeaderMap;
use serde::Serialize;
use std::{
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    sync::{mpsc, Arc, Mutex, MutexGuard, OnceLock},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};

const HOST: &str = "imap.qq.com";
const EVENT: &str = "qq-mail-changed";
const CREDENTIAL_SERVICE: &str = "com.focusd.island.qq-mail";
const MAX_ITEMS: u32 = 20;
const SYNC_INTERVAL: Duration = Duration::from_secs(60);
const IO_TIMEOUT: Duration = Duration::from_secs(15);
const HEADER_QUERY: &str = "(UID FLAGS INTERNALDATE BODY.PEEK[HEADER]<0.65536>)";
static SERVICE: OnceLock<Arc<MailService>> = OnceLock::new();

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailMessage {
    id: String,
    uid: u32,
    sender: String,
    subject: String,
    received_at: Option<i64>,
    unread: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MailStatus {
    Disconnected,
    Connecting,
    Connected,
    Paused,
    AuthRequired,
    Error,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailSnapshot {
    revision: u64,
    email: Option<String>,
    configured: bool,
    enabled: bool,
    syncing: bool,
    status: MailStatus,
    unread_count: Option<usize>,
    items: Vec<MailMessage>,
    last_synced_at: Option<i64>,
    error: Option<String>,
}

impl Default for MailSnapshot {
    fn default() -> Self {
        Self {
            revision: 0,
            email: None,
            configured: false,
            enabled: false,
            syncing: false,
            status: MailStatus::Disconnected,
            unread_count: None,
            items: Vec::new(),
            last_synced_at: None,
            error: None,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MailEvent {
    snapshot: MailSnapshot,
    newest_id: Option<String>,
    window_visible: bool,
}

#[derive(Clone, Copy)]
struct Cursor {
    validity: u32,
    high_water: u32,
}

struct Inbox {
    cursor: Cursor,
    unread_count: usize,
    items: Vec<MailMessage>,
}

#[derive(Debug)]
struct MailFailure {
    authentication: bool,
    message: &'static str,
}

impl MailFailure {
    fn network() -> Self {
        Self {
            authentication: false,
            message: "无法同步 QQ 邮箱，请检查网络或稍后重试。",
        }
    }

    fn authentication() -> Self {
        Self {
            authentication: true,
            message: "QQ 邮箱拒绝了连接，请确认已开启 IMAP，并重新输入邮箱授权码。",
        }
    }
}

#[derive(Default)]
struct MailState {
    snapshot: MailSnapshot,
    generation: u64,
    cursor: Option<Cursor>,
    failures: u32,
    next_check: Option<Instant>,
}

impl MailState {
    fn invalidate(&mut self) {
        self.generation += 1;
        self.cursor = None;
        self.failures = 0;
        self.next_check = None;
        self.snapshot.syncing = false;
    }

    fn changed(&mut self) -> MailSnapshot {
        self.snapshot.revision += 1;
        self.snapshot.clone()
    }

    fn accept(&mut self, generation: u64, inbox: Inbox) -> Option<(MailSnapshot, Option<String>)> {
        if generation != self.generation || !self.snapshot.enabled {
            return None;
        }
        let newest_id = self.cursor.and_then(|previous| {
            (previous.validity == inbox.cursor.validity)
                .then(|| {
                    inbox
                        .items
                        .iter()
                        .filter(|item| item.uid > previous.high_water && item.unread)
                        .max_by_key(|item| item.uid)
                        .map(|item| item.id.clone())
                })
                .flatten()
        });
        self.cursor = Some(Cursor {
            validity: inbox.cursor.validity,
            high_water: self
                .cursor
                .filter(|old| old.validity == inbox.cursor.validity)
                .map_or(inbox.cursor.high_water, |old| {
                    old.high_water.max(inbox.cursor.high_water)
                }),
        });
        self.snapshot.configured = true;
        self.snapshot.syncing = false;
        self.snapshot.status = MailStatus::Connected;
        self.snapshot.error = None;
        self.snapshot.items = inbox.items;
        self.snapshot.unread_count = Some(inbox.unread_count);
        self.snapshot.last_synced_at = Some(now_ms());
        self.failures = 0;
        self.next_check = Some(Instant::now() + SYNC_INTERVAL);
        Some((self.changed(), newest_id))
    }

    fn fail(&mut self, generation: u64, failure: &MailFailure) -> Option<MailSnapshot> {
        if generation != self.generation {
            return None;
        }
        self.snapshot.syncing = false;
        self.snapshot.status = if failure.authentication {
            MailStatus::AuthRequired
        } else {
            MailStatus::Error
        };
        self.snapshot.error = Some(failure.message.into());
        self.failures = self.failures.saturating_add(1);
        self.next_check =
            if failure.authentication || !self.snapshot.configured || !self.snapshot.enabled {
                None
            } else {
                Some(Instant::now() + retry_delay(self.failures))
            };
        Some(self.changed())
    }
}

type Reply = mpsc::Sender<Result<MailSnapshot, String>>;

enum Work {
    Connect {
        generation: u64,
        email: String,
        secret: String,
        reply: Reply,
    },
    Refresh {
        generation: u64,
        reply: Reply,
    },
    Wake,
}

struct MailService {
    app: AppHandle,
    state: Mutex<MailState>,
    sender: mpsc::Sender<Work>,
}

impl MailService {
    fn lock(&self) -> Result<MutexGuard<'_, MailState>, String> {
        self.state.lock().map_err(|_| "QQ 邮箱状态不可用。".into())
    }

    fn publish(&self, snapshot: MailSnapshot, newest_id: Option<String>) {
        let window_visible = self
            .app
            .get_webview_window("main")
            .is_some_and(|window| window.is_visible().unwrap_or(false));
        let _ = self.app.emit(
            EVENT,
            MailEvent {
                snapshot,
                newest_id,
                window_visible,
            },
        );
    }

    fn begin_sync(&self) -> Option<(u64, String)> {
        let mut state = self.lock().ok()?;
        if !state.snapshot.enabled
            || !state.snapshot.configured
            || state.snapshot.syncing
            || state.snapshot.status == MailStatus::AuthRequired
        {
            return None;
        }
        let email = state.snapshot.email.clone()?;
        state.snapshot.syncing = true;
        state.next_check = None;
        if state.snapshot.last_synced_at.is_none() {
            state.snapshot.status = MailStatus::Connecting;
        }
        let generation = state.generation;
        let snapshot = state.changed();
        drop(state);
        self.publish(snapshot, None);
        Some((generation, email))
    }

    fn sync(
        &self,
        generation: u64,
        email: &str,
        secret: Option<&str>,
    ) -> Result<MailSnapshot, String> {
        {
            let state = self.lock()?;
            if generation != state.generation || !state.snapshot.enabled {
                return Err("邮箱连接已取消。".into());
            }
        }
        let result = match secret {
            Some(secret) => fetch_remote(email, secret),
            None => match read_secret(email) {
                Ok(Some(secret)) => fetch_remote(email, &secret),
                Ok(None) => Err(MailFailure::authentication()),
                Err(_) => Err(MailFailure {
                    authentication: true,
                    message: "无法读取 Windows 邮箱凭据，请重新连接。",
                }),
            },
        };
        let mut state = self.lock()?;
        if generation != state.generation || !state.snapshot.enabled {
            return Err("邮箱连接已取消。".into());
        }
        let result = result.and_then(|inbox| {
            if let Some(secret) = secret {
                credential(email)
                    .and_then(|entry| {
                        entry
                            .set_password(secret)
                            .map_err(|_| "无法保存邮箱凭据。".into())
                    })
                    .map_err(|_| MailFailure {
                        authentication: false,
                        message: "无法保存到 Windows 凭据管理器，请重试连接。",
                    })?;
            }
            Ok(inbox)
        });
        match result {
            Ok(inbox) => {
                let (snapshot, newest_id) = state
                    .accept(generation, inbox)
                    .ok_or_else(|| "邮箱连接已取消。".to_string())?;
                drop(state);
                self.publish(snapshot.clone(), newest_id);
                Ok(snapshot)
            }
            Err(failure) => {
                let snapshot = state.fail(generation, &failure);
                drop(state);
                if let Some(snapshot) = snapshot {
                    self.publish(snapshot, None);
                }
                Err(failure.message.into())
            }
        }
    }
}

pub fn init(app: &AppHandle) -> Result<(), String> {
    if SERVICE.get().is_some() {
        return Ok(());
    }
    let (sender, receiver) = mpsc::channel();
    let service = Arc::new(MailService {
        app: app.clone(),
        state: Mutex::new(MailState::default()),
        sender,
    });
    SERVICE
        .set(service.clone())
        .map_err(|_| "QQ 邮箱服务已启动。")?;
    thread::Builder::new()
        .name("qq-mail".into())
        .spawn(move || worker(service, receiver))
        .map_err(|_| "无法启动 QQ 邮箱服务。".to_string())?;
    Ok(())
}

fn service() -> Result<&'static Arc<MailService>, String> {
    SERVICE.get().ok_or_else(|| "QQ 邮箱服务尚未就绪。".into())
}

fn worker(service: Arc<MailService>, receiver: mpsc::Receiver<Work>) {
    loop {
        let wait = match service.lock() {
            Ok(state) => state
                .next_check
                .map(|deadline| deadline.saturating_duration_since(Instant::now()))
                .unwrap_or(Duration::from_secs(3_600)),
            Err(_) => return,
        };
        match receiver.recv_timeout(wait) {
            Ok(Work::Connect {
                generation,
                email,
                secret,
                reply,
            }) => {
                let _ = reply.send(service.sync(generation, &email, Some(&secret)));
            }
            Ok(Work::Refresh { generation, reply }) => {
                let email = service
                    .lock()
                    .ok()
                    .and_then(|state| state.snapshot.email.clone());
                let result = email
                    .ok_or_else(|| "请先连接 QQ 邮箱。".to_string())
                    .and_then(|email| service.sync(generation, &email, None));
                let _ = reply.send(result);
            }
            Ok(Work::Wake) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Some((generation, email)) = service.begin_sync() {
                    let _ = service.sync(generation, &email, None);
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
    }
}

#[tauri::command]
pub fn get_qq_mail_state() -> Result<MailSnapshot, String> {
    Ok(service()?.lock()?.snapshot.clone())
}

#[tauri::command]
pub async fn connect_qq_mail(
    email: String,
    authorization_code: String,
) -> Result<MailSnapshot, String> {
    let email = normalize_email(&email)?;
    let secret = authorization_code.trim().to_string();
    if secret.is_empty() || secret.len() > 256 || secret.chars().any(char::is_control) {
        return Err("请输入 QQ 邮箱设置中生成的授权码。".into());
    }
    let service = service()?;
    let (generation, snapshot) = {
        let mut state = service.lock()?;
        if state.snapshot.configured
            && state
                .snapshot
                .email
                .as_ref()
                .is_some_and(|current| current != &email)
        {
            return Err("请先断开当前邮箱，再连接其他账号。".into());
        }
        state.invalidate();
        state.snapshot.email = Some(email.clone());
        state.snapshot.enabled = true;
        state.snapshot.syncing = true;
        state.snapshot.status = MailStatus::Connecting;
        state.snapshot.error = None;
        (state.generation, state.changed())
    };
    service.publish(snapshot, None);
    let (reply, receiver) = mpsc::channel();
    service
        .sender
        .send(Work::Connect {
            generation,
            email,
            secret,
            reply,
        })
        .map_err(|_| "QQ 邮箱服务不可用。".to_string())?;
    await_reply(receiver).await
}

#[tauri::command]
pub async fn set_qq_mail_enabled(email: String, enabled: bool) -> Result<MailSnapshot, String> {
    let email = normalize_email(&email)?;
    tauri::async_runtime::spawn_blocking(move || {
        let service = service()?;
        let mut state = service.lock()?;
        if state
            .snapshot
            .email
            .as_ref()
            .is_some_and(|current| current != &email)
        {
            return Err("请先断开当前邮箱，再连接其他账号。".into());
        }
        if state.snapshot.email.as_ref() == Some(&email)
            && state.snapshot.configured
            && state.snapshot.enabled == enabled
        {
            return Ok(state.snapshot.clone());
        }
        let configured = read_secret(&email)?.is_some();
        state.invalidate();
        state.snapshot.email = Some(email);
        state.snapshot.configured = configured;
        state.snapshot.enabled = enabled && configured;
        state.snapshot.status = if !configured {
            MailStatus::AuthRequired
        } else if enabled {
            MailStatus::Connecting
        } else {
            MailStatus::Paused
        };
        state.snapshot.error = if configured {
            None
        } else {
            Some("未找到保存的邮箱授权码，请重新连接。".into())
        };
        if enabled && configured {
            state.next_check = Some(Instant::now());
        }
        let snapshot = state.changed();
        drop(state);
        service.publish(snapshot.clone(), None);
        let _ = service.sender.send(Work::Wake);
        Ok(snapshot)
    })
    .await
    .map_err(|_| "无法更新 QQ 邮箱连接。".to_string())?
}

#[tauri::command]
pub async fn refresh_qq_mail() -> Result<MailSnapshot, String> {
    let service = service()?;
    let Some((generation, _)) = service.begin_sync() else {
        let snapshot = service.lock()?.snapshot.clone();
        return if snapshot.syncing {
            Ok(snapshot)
        } else {
            Err("请先连接并开启 QQ 邮箱接收。".into())
        };
    };
    let (reply, receiver) = mpsc::channel();
    service
        .sender
        .send(Work::Refresh { generation, reply })
        .map_err(|_| "QQ 邮箱服务不可用。".to_string())?;
    await_reply(receiver).await
}

#[tauri::command]
pub async fn disconnect_qq_mail() -> Result<MailSnapshot, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let service = service()?;
        let mut state = service.lock()?;
        state.invalidate();
        state.snapshot.enabled = false;
        if let Some(email) = &state.snapshot.email {
            if delete_secret(email).is_err() {
                state.snapshot.status = MailStatus::Paused;
                state.snapshot.error =
                    Some("已停止接收，但删除 Windows 邮箱凭据失败，请重试断开。".into());
                let snapshot = state.changed();
                drop(state);
                service.publish(snapshot, None);
                return Err("删除邮箱凭据失败，请重试断开。".into());
            }
        }
        let revision = state.snapshot.revision;
        state.snapshot = MailSnapshot {
            revision,
            ..MailSnapshot::default()
        };
        let snapshot = state.changed();
        drop(state);
        service.publish(snapshot.clone(), None);
        Ok(snapshot)
    })
    .await
    .map_err(|_| "无法断开 QQ 邮箱。".to_string())?
}

async fn await_reply(
    receiver: mpsc::Receiver<Result<MailSnapshot, String>>,
) -> Result<MailSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv()
            .unwrap_or_else(|_| Err("QQ 邮箱服务不可用。".into()))
    })
    .await
    .map_err(|_| "QQ 邮箱连接任务未完成。".to_string())?
}

fn credential(email: &str) -> Result<Entry, String> {
    Entry::new(CREDENTIAL_SERVICE, email).map_err(|_| "无法访问 Windows 邮箱凭据。".into())
}

fn read_secret(email: &str) -> Result<Option<String>, String> {
    match credential(email)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(_) => Err("无法读取 Windows 邮箱凭据。".into()),
    }
}

fn delete_secret(email: &str) -> Result<(), String> {
    match credential(email)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(_) => Err("无法删除 Windows 邮箱凭据。".into()),
    }
}

fn normalize_email(email: &str) -> Result<String, String> {
    let email = email.trim().to_ascii_lowercase();
    let local = email.strip_suffix("@qq.com").unwrap_or("");
    if local.is_empty()
        || local.len() > 64
        || !local
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._+-".contains(&byte))
    {
        return Err("请输入有效的 @qq.com 邮箱地址。".into());
    }
    Ok(email)
}

fn retry_delay(failures: u32) -> Duration {
    Duration::from_secs(match failures {
        0 | 1 => 60,
        2 => 120,
        _ => 300,
    })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn login_failure(error: imap::Error) -> MailFailure {
    match error {
        imap::Error::No(_) | imap::Error::Bad(_) => MailFailure::authentication(),
        _ => MailFailure::network(),
    }
}

fn fetch_remote(email: &str, secret: &str) -> Result<Inbox, MailFailure> {
    let mut stream = None;
    let addresses = (HOST, 993)
        .to_socket_addrs()
        .map_err(|_| MailFailure::network())?;
    for address in addresses {
        if let Ok(connected) = TcpStream::connect_timeout(&address, Duration::from_secs(10)) {
            stream = Some(connected);
            break;
        }
    }
    let stream = stream.ok_or_else(MailFailure::network)?;
    stream
        .set_read_timeout(Some(IO_TIMEOUT))
        .map_err(|_| MailFailure::network())?;
    stream
        .set_write_timeout(Some(IO_TIMEOUT))
        .map_err(|_| MailFailure::network())?;
    let tls = native_tls::TlsConnector::new().map_err(|_| MailFailure::network())?;
    let stream = tls
        .connect(HOST, stream)
        .map_err(|_| MailFailure::network())?;
    let mut client = imap::Client::new(stream);
    client.read_greeting().map_err(|_| MailFailure::network())?;
    let mut session = client
        .login(email, secret)
        .map_err(|(error, _)| login_failure(error))?;
    let result = fetch_inbox(&mut session);
    let _ = session.logout();
    result
}

fn fetch_inbox<T: Read + Write>(session: &mut Session<T>) -> Result<Inbox, MailFailure> {
    let mailbox = session
        .examine("INBOX")
        .map_err(|_| MailFailure::network())?;
    let validity = mailbox
        .uid_validity
        .filter(|value| *value > 0)
        .ok_or_else(MailFailure::network)?;
    let unseen = session
        .uid_search("UNSEEN")
        .map_err(|_| MailFailure::network())?;
    let mut items = Vec::new();
    if mailbox.exists > 0 {
        let first = mailbox.exists.saturating_sub(MAX_ITEMS - 1).max(1);
        let messages = session
            .fetch(format!("{first}:{}", mailbox.exists), HEADER_QUERY)
            .map_err(|_| MailFailure::network())?;
        for message in messages
            .iter()
            .filter(|message| (first..=mailbox.exists).contains(&message.message))
        {
            let Some(uid) = message.uid else {
                return Err(MailFailure::network());
            };
            // Unsolicited flag-only FETCH responses must not become blank list entries.
            let Some(header) = message.header() else {
                continue;
            };
            let (sender, subject) = parse_header(header);
            items.push(MailMessage {
                id: format!("{validity}:{uid}"),
                uid,
                sender,
                subject,
                received_at: message.internal_date().map(|date| date.timestamp_millis()),
                unread: !message.flags().contains(&Flag::Seen),
            });
        }
    }
    items.sort_by_key(|item| std::cmp::Reverse(item.uid));
    items.dedup_by_key(|item| item.uid);
    items.truncate(MAX_ITEMS as usize);
    let high_water = mailbox
        .uid_next
        .unwrap_or(1)
        .saturating_sub(1)
        .max(items.iter().map(|item| item.uid).max().unwrap_or(0));
    Ok(Inbox {
        cursor: Cursor {
            validity,
            high_water,
        },
        unread_count: unseen.len(),
        items,
    })
}

fn parse_header(raw: &[u8]) -> (String, String) {
    let headers = mailparse::parse_headers(raw)
        .map(|(headers, _)| headers)
        .unwrap_or_default();
    let sender = headers.get_first_value("From").unwrap_or_default();
    let subject = headers.get_first_value("Subject").unwrap_or_default();
    (
        display_header(&sender, "未知发件人"),
        display_header(&subject, "（无主题）"),
    )
}

fn display_header(value: &str, fallback: &str) -> String {
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if value.is_empty() {
        fallback.into()
    } else {
        value.chars().take(1_000).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor as IoCursor;

    fn inbox(validity: u32, uids: &[u32]) -> Inbox {
        Inbox {
            cursor: Cursor {
                validity,
                high_water: uids.iter().copied().max().unwrap_or(0),
            },
            unread_count: uids.len(),
            items: uids
                .iter()
                .map(|uid| MailMessage {
                    id: format!("{validity}:{uid}"),
                    uid: *uid,
                    sender: "sender@example.com".into(),
                    subject: "主题".into(),
                    received_at: None,
                    unread: true,
                })
                .collect(),
        }
    }

    fn active_state() -> MailState {
        MailState {
            snapshot: MailSnapshot {
                enabled: true,
                configured: true,
                ..MailSnapshot::default()
            },
            ..MailState::default()
        }
    }

    #[test]
    fn validates_qq_addresses_and_rejects_other_hosts_or_commands() {
        assert_eq!(normalize_email(" User@QQ.COM ").unwrap(), "user@qq.com");
        for email in [
            "",
            "@qq.com",
            "a@gmail.com",
            "a@qq.com.evil",
            "a\r\nLOGIN@qq.com",
        ] {
            assert!(normalize_email(email).is_err());
        }
    }

    #[test]
    fn decodes_chinese_mime_headers_and_handles_empty_subjects() {
        let (sender, subject) = parse_header(b"From: =?UTF-8?B?5byg5LiJ?= <sender@example.com>\r\nSubject: =?UTF-8?B?5Lya6K6u?=\r\n\r\n");
        assert!(sender.contains("张三"));
        assert_eq!(subject, "会议");
        assert_eq!(parse_header(b"Subject: =?GB2312?B?1tDOxA==?=\r\n\r\n").1, "中文");
        assert_eq!(parse_header(b"\r\n").1, "（无主题）");
        assert_eq!(display_header("line\r\n two", ""), "line two");
    }

    #[test]
    fn first_sync_and_uid_validity_reset_do_not_replay_history() {
        let mut state = active_state();
        assert!(state.accept(0, inbox(1, &[1, 2])).unwrap().1.is_none());
        assert!(state.accept(0, inbox(1, &[1, 2])).unwrap().1.is_none());
        assert_eq!(
            state.accept(0, inbox(1, &[1, 2, 3])).unwrap().1.as_deref(),
            Some("1:3")
        );
        assert!(state.accept(0, inbox(2, &[10, 11])).unwrap().1.is_none());
        state.invalidate();
        assert!(state
            .accept(1, inbox(2, &[10, 11, 12]))
            .unwrap()
            .1
            .is_none());
    }

    #[test]
    fn old_or_read_messages_are_not_new_arrivals() {
        let mut state = active_state();
        state.accept(0, inbox(1, &[40]));
        assert!(state.accept(0, inbox(1, &[39])).unwrap().1.is_none());
        let mut read = inbox(1, &[41]);
        read.items[0].unread = false;
        assert!(state.accept(0, read).unwrap().1.is_none());
        assert!(state.accept(0, inbox(1, &[41])).unwrap().1.is_none());
    }

    #[test]
    fn disconnect_invalidates_inflight_success_and_failure() {
        let mut state = active_state();
        state.invalidate();
        state.snapshot = MailSnapshot::default();
        assert!(state.accept(0, inbox(1, &[1])).is_none());
        assert!(state.fail(0, &MailFailure::network()).is_none());
        assert_eq!(state.snapshot.status, MailStatus::Disconnected);
        assert!(state.snapshot.items.is_empty());
    }

    #[test]
    fn network_errors_keep_data_and_authentication_errors_stop_retries() {
        let mut state = active_state();
        state.accept(0, inbox(1, &[1]));
        state.fail(0, &MailFailure::network());
        assert_eq!(state.snapshot.unread_count, Some(1));
        assert_eq!(state.snapshot.items.len(), 1);
        assert!(state.next_check.is_some());
        state.fail(0, &MailFailure::authentication());
        assert_eq!(state.snapshot.status, MailStatus::AuthRequired);
        assert!(state.next_check.is_none());
        assert_eq!(retry_delay(1).as_secs(), 60);
        assert_eq!(retry_delay(2).as_secs(), 120);
        assert_eq!(retry_delay(10).as_secs(), 300);
    }

    #[derive(Debug)]
    struct ScriptedStream {
        input: IoCursor<Vec<u8>>,
        output: Arc<Mutex<Vec<u8>>>,
    }
    impl Read for ScriptedStream {
        fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
            self.input.read(bytes)
        }
    }
    impl Write for ScriptedStream {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.output.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn client(script: String) -> (imap::Client<ScriptedStream>, Arc<Mutex<Vec<u8>>>) {
        let output = Arc::new(Mutex::new(Vec::new()));
        let mut client = imap::Client::new(ScriptedStream {
            input: IoCursor::new(script.into_bytes()),
            output: output.clone(),
        });
        client.read_greeting().unwrap();
        (client, output)
    }

    #[test]
    fn server_authentication_rejection_is_actionable_and_redacted() {
        let (client, _) = client("* OK ready\r\na1 NO invalid password\r\n".into());
        let (error, _) = client.login("user@qq.com", "test-secret").err().unwrap();
        let failure = login_failure(error);
        assert!(failure.authentication);
        assert!(!failure.message.contains("test-secret"));
    }

    #[test]
    fn reads_only_headers_and_counts_all_unread_not_just_recent_twenty() {
        let mut script = "* OK ready\r\na1 OK login\r\n* 25 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 7] valid\r\n* OK [UIDNEXT 26] next\r\na2 OK [READ-ONLY] examined\r\n* SEARCH".to_string();
        for uid in 1..=25 {
            script.push_str(&format!(" {uid}"));
        }
        script.push_str("\r\na3 OK search\r\n");
        let header = "From: sender@example.com\r\nSubject: Update\r\n\r\n";
        for uid in 6..=25 {
            script.push_str(&format!("* {uid} FETCH (UID {uid} FLAGS () INTERNALDATE \"19-Oct-2026 08:00:00 +0800\" BODY[HEADER]<0> {{{}}}\r\n{header})\r\n", header.len()));
        }
        script.push_str("a4 OK fetch\r\n");
        let (client, output) = client(script);
        let mut session = client.login("user@qq.com", "test-secret").unwrap();
        let inbox = fetch_inbox(&mut session).unwrap();
        assert_eq!(inbox.unread_count, 25);
        assert_eq!(inbox.items.len(), 20);
        assert_eq!(inbox.items[0].id, "7:25");
        let commands = String::from_utf8(output.lock().unwrap().clone()).unwrap();
        assert!(commands.contains("EXAMINE \"INBOX\""));
        assert!(commands.contains("UID SEARCH UNSEEN"));
        assert!(commands.contains(HEADER_QUERY));
        for forbidden in [" SELECT ", " STORE ", " EXPUNGE", "BODY[]", "BODY[TEXT]"] {
            assert!(!commands.contains(forbidden));
        }
    }

    #[test]
    fn empty_mailbox_is_a_successful_zero_unread_snapshot() {
        let (client, _) = client("* OK ready\r\na1 OK login\r\n* 0 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 1] valid\r\n* OK [UIDNEXT 1] next\r\na2 OK [READ-ONLY] examined\r\n* SEARCH\r\na3 OK search\r\n".into());
        let mut session = client.login("user@qq.com", "test-secret").unwrap();
        let inbox = fetch_inbox(&mut session).unwrap();
        assert_eq!(inbox.unread_count, 0);
        assert!(inbox.items.is_empty());
    }
}
