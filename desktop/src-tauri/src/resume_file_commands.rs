//! #429：桌面「简历资料 › 附件」的命令。
//!
//! 添加、替换时界面只给选文件窗口返回的路径，由这里读文件；档案里的存储路径不下发到界面。
//! 打开用和邮件附件同一个临时副本缓存（只开 PDF 和图片，Word 文件不经桌面打开）。

use std::io::Read;
use std::path::Path;

use archive_store::{ArchiveStore, ResumeFileKind, ResumeFileListing, ResumeFilePatch, MAX_RESUME_FILE_BYTES};
use serde::Serialize;
use tauri::AppHandle;

use crate::attachment_commands::AttachmentSummary;
use crate::commands::CommandError;
use crate::{archive_worker, with_store, AppState};

/// 照片缩略图用 `data:` 交给界面；一份内存里的副本，比这大的就不预览了。
const MAX_PREVIEW_BYTES: i64 = 8 * 1024 * 1024;

fn fail(code: &str, message: impl Into<String>) -> CommandError {
    CommandError { code: code.into(), message: message.into() }
}

/// 存储层的报错带着「invalid input: 」这类前缀，界面上只显示后面那句。
fn shown(error: archive_store::StoreError) -> CommandError {
    let mut command = CommandError::from(error);
    for prefix in ["invalid input: ", "conflict: ", "entity not found: ", "internal error: ", "io error: "] {
        if let Some(rest) = command.message.strip_prefix(prefix) {
            command.message = rest.to_string();
        }
    }
    command
}

/// 读用户选的文件：一个句柄读到底，超过上限在读满之前就停下。
fn read_picked(path: &Path) -> Result<(String, Vec<u8>), CommandError> {
    let unreadable = || fail("FILE_UNREADABLE", "读不了这个文件，请确认它还在、没被别的程序占用。");
    let file = std::fs::File::open(path).map_err(|_| unreadable())?;
    if !file.metadata().map_err(|_| unreadable())?.is_file() {
        return Err(unreadable());
    }
    let mut bytes = Vec::new();
    file.take(MAX_RESUME_FILE_BYTES as u64 + 1).read_to_end(&mut bytes).map_err(|_| unreadable())?;
    if bytes.len() > MAX_RESUME_FILE_BYTES {
        return Err(fail("VALIDATION", format!("文件超过 {} MB，没有添加。", MAX_RESUME_FILE_BYTES / 1024 / 1024)));
    }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
    Ok((name, bytes))
}

/// 能用的文件和读不出来的记录：后者界面上单独列出来，只能删掉。
pub fn list(store: &ArchiveStore) -> Result<ResumeFileListing, CommandError> {
    store.resume_file_listing().map_err(shown)
}

pub fn add(store: &ArchiveStore, kind: ResumeFileKind, path: &Path) -> Result<ResumeFileListing, CommandError> {
    let (name, bytes) = read_picked(path)?;
    store.add_resume_file(kind, &name, &bytes).map_err(shown)?;
    list(store)
}

pub fn replace(store: &ArchiveStore, id: &str, path: &Path) -> Result<ResumeFileListing, CommandError> {
    let (name, bytes) = read_picked(path)?;
    store.replace_resume_file(id, &name, &bytes).map_err(shown)?;
    list(store)
}

pub fn update(store: &ArchiveStore, id: &str, patch: &ResumeFilePatch) -> Result<ResumeFileListing, CommandError> {
    store.update_resume_file(id, patch).map_err(shown)?;
    list(store)
}

/// 删除以后的列表，带上清理之后附件目录里还会让备份停下的文件；核对出错时 `unchecked` 是原因。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeFileDeleted {
    #[serde(flatten)]
    pub listing: ResumeFileListing,
    pub leftovers: Vec<String>,
    pub unchecked: Option<String>,
}

pub fn delete(store: &ArchiveStore, id: &str) -> Result<ResumeFileDeleted, CommandError> {
    let deletion = store.delete_resume_file(id).map_err(shown)?;
    Ok(ResumeFileDeleted { listing: list(store)?, leftovers: deletion.leftovers, unchecked: deletion.unchecked })
}

/// 照片的缩略图。不是图片、太大或读不出来时是 `None`。
pub fn preview(store: &ArchiveStore, id: &str) -> Result<Option<String>, CommandError> {
    let Some(file) = store.resume_file(id).map_err(shown)? else {
        return Ok(None);
    };
    if !file.mime.starts_with("image/") || file.byte_size > MAX_PREVIEW_BYTES {
        return Ok(None);
    }
    let (file, bytes) = store.read_resume_file(id).map_err(shown)?;
    Ok(Some(format!("data:{};base64,{}", file.mime, resume_pro_protocol::encode_standard_base64(&bytes))))
}

#[tauri::command]
pub async fn list_resume_files_cmd(app: AppHandle) -> Result<ResumeFileListing, CommandError> {
    archive_worker(app, |state| with_store(state, list)).await
}

#[tauri::command]
pub async fn add_resume_file_cmd(app: AppHandle, kind: ResumeFileKind, path: String) -> Result<ResumeFileListing, CommandError> {
    archive_worker(app, move |state| with_store(state, |store| add(store, kind, Path::new(&path)))).await
}

#[tauri::command]
pub async fn replace_resume_file_cmd(app: AppHandle, id: String, path: String) -> Result<ResumeFileListing, CommandError> {
    archive_worker(app, move |state| with_store(state, |store| replace(store, &id, Path::new(&path)))).await
}

#[tauri::command]
pub async fn update_resume_file_cmd(app: AppHandle, id: String, patch: ResumeFilePatch) -> Result<ResumeFileListing, CommandError> {
    archive_worker(app, move |state| with_store(state, |store| update(store, &id, &patch))).await
}

#[tauri::command]
pub async fn delete_resume_file_cmd(app: AppHandle, id: String) -> Result<ResumeFileDeleted, CommandError> {
    archive_worker(app, move |state| with_store(state, |store| delete(store, &id))).await
}

#[tauri::command]
pub async fn preview_resume_file_cmd(app: AppHandle, id: String) -> Result<Option<String>, CommandError> {
    archive_worker(app, move |state| with_store(state, |store| preview(store, &id))).await
}

/// 用系统程序打开一份临时副本。和邮件附件一样只开 PDF 和图片。
#[tauri::command]
pub async fn open_resume_file_cmd(app: AppHandle, id: String) -> Result<(), CommandError> {
    let opener = app.clone();
    archive_worker(app, move |state: &AppState| {
        let (file, bytes) = with_store(state, |store| store.read_resume_file(&id).map_err(shown))?;
        let item = AttachmentSummary {
            index: 0,
            name: file.name.clone(),
            mime: file.mime.clone(),
            size_bytes: bytes.len(),
            preview_kind: String::new(),
            readable: true,
            can_open: file.mime == "application/pdf" || file.mime.starts_with("image/"),
        };
        let cache = state
            .paths
            .lock()
            .ok()
            .and_then(|p| p.as_ref().map(|p| p.cache_dir.clone()))
            .ok_or_else(|| fail("ATTACHMENT_WRITE", "无法定位附件缓存目录。"))?;
        state
            .opened_attachments
            .lock()
            .map_err(|_| fail("ATTACHMENT_WRITE", "附件副本暂存失败。"))?
            .open(&cache.join("opened-mail-attachments"), &item, &bytes, std::time::Instant::now(), |path| {
                tauri_plugin_opener::OpenerExt::opener(&opener)
                    .open_path(path.to_string_lossy(), None::<&str>)
                    .map_err(|_| fail("OPEN_FAILED", "系统没能打开这个文件。"))
            })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, ArchiveStore) {
        let dir = tempfile::TempDir::new().unwrap();
        let archive = dir.path().join("archive");
        std::fs::create_dir_all(&archive).unwrap();
        let store = crate::commands::open_store(&archive, &dir.path().join("current.json")).unwrap();
        (dir, store)
    }

    #[test]
    fn a_picked_file_is_read_by_path_and_its_errors_read_plainly() {
        let (dir, store) = store();
        let picked = dir.path().join("测试用户_简历.pdf");
        std::fs::write(&picked, b"%PDF-1.7\nbody").unwrap();
        let files = add(&store, ResumeFileKind::Resume, &picked).unwrap().files;
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, "测试用户_简历.pdf");
        // 同一份再加一次：报店里那句话，不带英文前缀。
        let again = add(&store, ResumeFileKind::Resume, &picked).unwrap_err();
        assert_eq!(again.code, "VALIDATION");
        assert!(again.message.starts_with("这份文件已经在附件里了"), "{}", again.message);
        let missing = add(&store, ResumeFileKind::Resume, &dir.path().join("不在.pdf")).unwrap_err();
        assert_eq!(missing.code, "FILE_UNREADABLE");
        let big = dir.path().join("大.pdf");
        std::fs::write(&big, [b"%PDF-1.7\n".as_slice(), &vec![0u8; MAX_RESUME_FILE_BYTES]].concat()).unwrap();
        assert_eq!(add(&store, ResumeFileKind::Resume, &big).unwrap_err().code, "VALIDATION");
    }

    #[test]
    fn only_photos_get_a_thumbnail() {
        let (dir, store) = store();
        let photo = dir.path().join("证件照.png");
        std::fs::write(&photo, [&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A][..], b"rest"].concat()).unwrap();
        let resume = dir.path().join("简历.pdf");
        std::fs::write(&resume, b"%PDF-1.7\nbody").unwrap();
        add(&store, ResumeFileKind::Photo, &photo).unwrap();
        let files = add(&store, ResumeFileKind::Resume, &resume).unwrap().files;
        let id_of = |kind: ResumeFileKind| files.iter().find(|f| f.kind == kind).unwrap().id.clone();
        assert!(preview(&store, &id_of(ResumeFileKind::Photo)).unwrap().unwrap().starts_with("data:image/png;base64,"));
        assert_eq!(preview(&store, &id_of(ResumeFileKind::Resume)).unwrap(), None);
        assert_eq!(preview(&store, "11111111-1111-4111-8111-111111111111").unwrap(), None);
    }
}
