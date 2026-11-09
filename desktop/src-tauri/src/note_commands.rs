use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use archive_store::notes::{
    note_file_mime, NoteChange, NoteDraft, NoteIndex, NoteUpload, MAX_NOTE_BATCH_BYTES,
    MAX_NOTE_FILES, MAX_NOTE_FILE_BYTES,
};
use resume_pro_protocol::{decode_standard_base64, encode_standard_base64};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
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
pub fn set_note_editing_cmd(state: State<NoteEditing>, editing: bool) {
    state.0.store(editing, Ordering::Relaxed);
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
    path: String,
) -> Result<FileContents, CommandError> {
    archive_worker(app, move |_| {
        let (name, bytes) = crate::resume_file_commands::read_picked(Path::new(&path))?;
        let mime = note_file_mime(&bytes)
            .filter(|mime| mime.starts_with("image/"))
            .ok_or_else(|| failure("拖入的文件应为 PNG、JPG、GIF 或 WebP 图片。"))?;
        Ok(contents(name, mime.into(), &bytes))
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
