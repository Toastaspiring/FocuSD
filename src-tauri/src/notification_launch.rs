//! Reads the full toast payload Windows keeps for each notification.
//!
//! The `UserNotificationListener` API only exposes a toast's text, not its
//! `launch` argument (the deep link Windows uses when the user clicks the
//! notification in the hub). That argument lives in the same store Windows
//! reads — `wpndatabase.db` — keyed by the notification id. We read it there and
//! hand it back so a Chromium browser can be activated exactly as Windows would.

use std::{collections::HashMap, path::PathBuf};

/// The activation and dismissal details Windows keeps for one notification.
pub struct Record {
    /// The sending app's AppUserModelId (handler primary id).
    pub app: String,
    /// The toast's `launch` argument — the deep link Windows activates on click.
    pub launch: String,
    /// The toast tag and group, used to remove it from the hub.
    pub tag: String,
    pub group: String,
}

/// Looks up a notification by its platform id in the Windows notification store.
pub fn record_for_db_id(db_id: i64) -> Option<Record> {
    let source = PathBuf::from(std::env::var_os("LOCALAPPDATA")?)
        .join(r"Microsoft\Windows\Notifications\wpndatabase.db");
    // The live DB is held open by Windows and may use a WAL, so copy the db and
    // its sidecars and read from the copy.
    let copy = std::env::temp_dir().join("focusd-island-wpn.db");
    std::fs::copy(&source, &copy).ok()?;
    for suffix in ["-wal", "-shm"] {
        let from = append_suffix(&source, suffix);
        if from.exists() {
            let _ = std::fs::copy(&from, append_suffix(&copy, suffix));
        }
    }

    let connection = rusqlite::Connection::open_with_flags(
        &copy,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    let (payload, app, tag, group): (Vec<u8>, Option<String>, Option<String>, Option<String>) =
        connection
            .query_row(
                "SELECT n.Payload, nh.PrimaryId, n.Tag, n.\"Group\" FROM Notification n \
                 LEFT JOIN NotificationHandler nh ON n.HandlerId = nh.RecordId \
                 WHERE n.Id = ?1",
                [db_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .ok()?;
    let xml = String::from_utf8_lossy(&payload);
    Some(Record {
        app: app.unwrap_or_default(),
        launch: extract_launch(&xml).unwrap_or_default(),
        tag: tag.unwrap_or_default(),
        group: group.unwrap_or_default(),
    })
}

/// Returns, for each notification id, the local image file its toast shows
/// (the `appLogoOverride` image — e.g. a Chrome notification's own logo). Opens
/// the store once for the whole batch.
pub fn image_paths_for_db_ids(ids: &[i64]) -> HashMap<i64, PathBuf> {
    let mut out = HashMap::new();
    if ids.is_empty() {
        return out;
    }
    let Some(connection) = open_store_copy() else {
        return out;
    };
    let Ok(mut statement) =
        connection.prepare("SELECT Payload FROM Notification WHERE Id = ?1")
    else {
        return out;
    };
    for &id in ids {
        let payload: Option<Vec<u8>> = statement
            .query_row([id], |row| row.get(0))
            .ok();
        if let Some(payload) = payload {
            let xml = String::from_utf8_lossy(&payload);
            if let Some(path) = extract_app_logo(&xml) {
                // Only local image files can be read back into the webview.
                if path.is_file() {
                    out.insert(id, path);
                }
            }
        }
    }
    out
}

/// Opens a read-only copy of the Windows notification store.
fn open_store_copy() -> Option<rusqlite::Connection> {
    let source = PathBuf::from(std::env::var_os("LOCALAPPDATA")?)
        .join(r"Microsoft\Windows\Notifications\wpndatabase.db");
    let copy = std::env::temp_dir().join("focusd-island-wpn.db");
    std::fs::copy(&source, &copy).ok()?;
    for suffix in ["-wal", "-shm"] {
        let from = append_suffix(&source, suffix);
        if from.exists() {
            let _ = std::fs::copy(&from, append_suffix(&copy, suffix));
        }
    }
    rusqlite::Connection::open_with_flags(
        &copy,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()
}

/// Extracts the `appLogoOverride` image path from a toast payload.
fn extract_app_logo(xml: &str) -> Option<PathBuf> {
    // Find the <image> element that is the app-logo override and read its src.
    let mut search = xml;
    while let Some(start) = search.find("<image") {
        let rest = &search[start..];
        let end = rest.find("/>").or_else(|| rest.find('>'))?;
        let element = &rest[..end];
        if element.contains("appLogoOverride") {
            if let Some(src_at) = element.find("src=\"") {
                let after = &element[src_at + "src=\"".len()..];
                if let Some(close) = after.find('"') {
                    let src = unescape_xml(&after[..close]);
                    if !src.is_empty() {
                        return Some(PathBuf::from(src));
                    }
                }
            }
        }
        search = &rest[end..];
    }
    None
}

fn append_suffix(path: &std::path::Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    path.with_file_name(name)
}

/// Extracts and unescapes the `launch="..."` attribute of the toast element.
fn extract_launch(xml: &str) -> Option<String> {
    let start = xml.find("launch=\"")? + "launch=\"".len();
    let rest = &xml[start..];
    let end = rest.find('"')?;
    let raw = &rest[..end];
    if raw.is_empty() {
        return None;
    }
    Some(unescape_xml(raw))
}

fn unescape_xml(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_and_unescapes_the_launch_argument() {
        let xml = r#"<toast launch="0|0|Default|Chrome|0|https://x.test/?a=1&amp;b=2|p#1"><visual/></toast>"#;
        assert_eq!(
            extract_launch(xml).unwrap(),
            "0|0|Default|Chrome|0|https://x.test/?a=1&b=2|p#1"
        );
        assert_eq!(extract_launch("<toast><visual/></toast>"), None);
        assert_eq!(extract_launch(r#"<toast launch=""/>"#), None);
    }
}
