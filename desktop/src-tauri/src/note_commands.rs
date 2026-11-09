use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use archive_store::notes::{
    note_file_mime, NoteChange, NoteDraft, NoteIndex, NoteUpload, MAX_NOTE_BATCH_BYTES,
    MAX_NOTE_FILES, MAX_NOTE_FILE_BYTES,
};
use resume_pro_protocol::{decode_standard_base64, encode_standard_base64};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, Window};
use tauri_plugin_opener::OpenerExt;

use crate::attachment_commands::AttachmentSummary;
use crate::commands::CommandError;
use crate::{archive_worker, with_store, AppState};

fn failure(message: &str) -> CommandError {
    CommandError {
        code: "NOTE_FILE_ERROR".into(),
        message: message.into(),
    }
}

// A tray quit normally exits immediately. If the editor is open, the WebView
// first flushes its latest revision and gives the user a choice on failure.
#[derive(Default)]
pub struct NoteEditing(AtomicBool);

impl NoteEditing {
    pub fn active(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

#[tauri::command]
pub fn set_note_editing_cmd(state: State<NoteEditing>, drops: State<NoteDrops>, editing: bool) {
    state.0.store(editing, Ordering::Relaxed);
    if !editing {
        if let Ok(mut pending) = drops.0.lock() {
            *pending = None;
        }
    }
}

const DROP_GRANT_LIFETIME: Duration = Duration::from_secs(30);

struct DropGrant {
    token: String,
    paths: Vec<PathBuf>,
    expires: Instant,
}

#[derive(Default)]
pub struct NoteDrops(Mutex<Option<DropGrant>>);

impl NoteDrops {
    fn grant(&self, paths: &[PathBuf], now: Instant) -> Result<String, CommandError> {
        let mut pending = self
            .0
            .lock()
            .map_err(|_| failure("无法接收拖入的图片，请重试。"))?;
        *pending = None;
        if paths.len() > MAX_NOTE_FILES {
            return Err(failure("一次最多拖入 30 张图片。"));
        }
        if paths.is_empty() || paths.iter().any(|path| !path.is_absolute()) {
            return Err(failure("未收到可读取的拖入文件。"));
        }
        let token = uuid::Uuid::new_v4().to_string();
        *pending = Some(DropGrant {
            token: token.clone(),
            paths: paths.to_vec(),
            expires: now + DROP_GRANT_LIFETIME,
        });
        Ok(token)
    }

    fn claim(&self, token: &str, now: Instant) -> Result<Vec<PathBuf>, CommandError> {
        let invalid = || failure("拖入授权无效或已过期，请重新拖入图片。");
        let mut pending = self.0.lock().map_err(|_| invalid())?;
        match pending.as_ref() {
            Some(grant) if now >= grant.expires => {
                *pending = None;
                Err(invalid())
            }
            Some(grant) if grant.token == token => Ok(pending.take().unwrap().paths),
            _ => Err(invalid()),
        }
    }
}

pub fn grant_native_drop(
    window: &Window,
    paths: &[PathBuf],
    position: &tauri::PhysicalPosition<f64>,
) {
    if !window.state::<NoteEditing>().active() || paths.is_empty() {
        return;
    }
    // Only the host's OS drop event reaches this path. The generic WebView
    // drag event is for UI feedback and carries no read authority.
    let authorization = window.state::<NoteDrops>().grant(paths, Instant::now());
    let payload = match authorization {
        Ok(token) => serde_json::json!({ "token": token, "position": position }),
        Err(error) => serde_json::json!({ "error": error.message, "position": position }),
    };
    let _ = window.emit_to(window.label(), "note-image-drop", payload);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Upload {
    id: String,
    name: String,
    base64: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContents {
    name: String,
    mime: String,
    base64: String,
}

fn contents(name: String, mime: String, bytes: &[u8]) -> FileContents {
    FileContents {
        name,
        mime,
        base64: encode_standard_base64(bytes),
    }
}

#[tauri::command]
pub async fn note_index_cmd(app: AppHandle) -> Result<NoteIndex, CommandError> {
    archive_worker(app, |state| {
        with_store(state, |store| Ok(store.note_index()?))
    })
    .await
}

#[tauri::command]
pub async fn note_body_cmd(
    app: AppHandle,
    epoch: String,
    id: String,
) -> Result<String, CommandError> {
    archive_worker(app, move |state| {
        with_store(state, |store| {
            store.check_notes_epoch(&epoch)?;
            Ok(store.note_body(&id)?)
        })
    })
    .await
}

#[tauri::command]
pub async fn save_note_cmd(
    app: AppHandle,
    epoch: String,
    draft: NoteDraft,
    uploads: Vec<Upload>,
) -> Result<(), CommandError> {
    archive_worker(app, move |state| {
        if uploads.len() > MAX_NOTE_FILES
            || uploads.iter().map(|file| file.base64.len()).sum::<usize>()
                > MAX_NOTE_BATCH_BYTES.div_ceil(3) * 4 + MAX_NOTE_FILES * 4
        {
            return Err(failure("本次保存的附件过多或过大。"));
        }
        let uploads = uploads
            .into_iter()
            .map(|upload| {
                if upload.base64.len() > MAX_NOTE_FILE_BYTES.div_ceil(3) * 4 {
                    return Err(failure("单个附件最多 10 MB。"));
                }
                Ok(NoteUpload {
                    id: upload.id,
                    name: upload.name,
                    bytes: decode_standard_base64(&upload.base64)
                        .map_err(|_| failure("附件数据格式无效。"))?,
                })
            })
            .collect::<Result<Vec<_>, CommandError>>()?;
        with_store(state, |store| {
            store.check_notes_epoch(&epoch)?;
            Ok(store.save_note(draft, uploads)?)
        })
    })
    .await
}

#[tauri::command]
pub async fn change_note_cmd(
    app: AppHandle,
    epoch: String,
    change: NoteChange,
) -> Result<Option<String>, CommandError> {
    archive_worker(app, move |state| {
        with_store(state, |store| {
            store.check_notes_epoch(&epoch)?;
            Ok(store.change_note(change)?)
        })
    })
    .await
}

#[tauri::command]
pub async fn read_note_file_cmd(
    app: AppHandle,
    epoch: String,
    id: String,
) -> Result<FileContents, CommandError> {
    archive_worker(app, move |state| {
        with_store(state, |store| {
            store.check_notes_epoch(&epoch)?;
            let (name, mime, bytes) = store.read_note_file(&id)?;
            Ok(contents(name, mime, &bytes))
        })
    })
    .await
}

#[tauri::command]
pub async fn read_note_drop_cmd(
    app: AppHandle,
    token: String,
) -> Result<Vec<FileContents>, CommandError> {
    let paths = app.state::<NoteDrops>().claim(&token, Instant::now())?;
    archive_worker(app, move |_| {
        let mut files = Vec::new();
        let mut total = 0;
        for path in paths {
            if !path.is_file() {
                return Err(failure("请选择图片文件。"));
            }
            let (name, bytes) = crate::resume_file_commands::read_picked(&path)?;
            let mime = note_file_mime(&bytes)
                .filter(|mime| mime.starts_with("image/"))
                .ok_or_else(|| failure("拖入的文件应为 PNG、JPG、GIF 或 WebP 图片。"))?;
            total += bytes.len();
            if total > MAX_NOTE_BATCH_BYTES {
                return Err(failure("拖入的图片合计超过 30 MB。"));
            }
            files.push(contents(name, mime.into(), &bytes));
        }
        Ok(files)
    })
    .await
}

#[tauri::command]
pub async fn open_note_pdf_cmd(
    app: AppHandle,
    epoch: String,
    id: String,
) -> Result<(), CommandError> {
    let opener = app.clone();
    archive_worker(app, move |state: &AppState| {
        let (name, mime, bytes) = with_store(state, |store| {
            store.check_notes_epoch(&epoch)?;
            Ok(store.read_note_file(&id)?)
        })?;
        if mime != "application/pdf" {
            return Err(failure("这个附件不是 PDF。"));
        }
        let item = AttachmentSummary {
            index: 0,
            name,
            mime,
            size_bytes: bytes.len(),
            preview_kind: String::new(),
            readable: true,
            can_open: true,
        };
        let cache = state
            .paths
            .lock()
            .ok()
            .and_then(|paths| paths.as_ref().map(|paths| paths.cache_dir.clone()))
            .ok_or_else(|| failure("无法定位附件缓存目录。"))?;
        state
            .opened_attachments
            .lock()
            .map_err(|_| failure("附件副本暂存失败。"))?
            .open(
                &cache.join("opened-mail-attachments"),
                &item,
                &bytes,
                std::time::Instant::now(),
                |path| {
                    opener
                        .opener()
                        .open_path(path.to_string_lossy(), None::<&str>)
                        .map_err(|_| failure("系统没能打开这个 PDF。"))
                },
            )
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_drop_grants_only_its_files_once() {
        let drops = NoteDrops::default();
        let now = Instant::now();
        let path = std::env::temp_dir().join("authorized.png");
        let other = std::env::temp_dir().join("private.png");
        let token = drops.grant(std::slice::from_ref(&path), now).unwrap();

        assert!(drops.claim(other.to_str().unwrap(), now).is_err());
        assert_eq!(drops.claim(&token, now).unwrap(), vec![path]);
        assert!(drops.claim(&token, now).is_err());
    }

    #[test]
    fn expired_and_superseded_drops_cannot_be_reused() {
        let drops = NoteDrops::default();
        let now = Instant::now();
        let paths = [std::env::temp_dir().join("drop.png")];
        let old = drops.grant(&paths, now).unwrap();
        let latest = drops.grant(&paths, now).unwrap();

        assert!(drops.claim(&old, now).is_err());
        assert!(drops.claim(&latest, now + DROP_GRANT_LIFETIME).is_err());
        assert!(drops.claim(&latest, now).is_err());
    }
}
