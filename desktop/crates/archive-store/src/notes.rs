use std::collections::{HashMap, HashSet};
use std::io::Read;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::identity::{is_uuid, new_uuid};
use crate::snapshot_file::write_atomically;
use crate::timeutil::{date_format, now_utc};
use crate::{ArchiveStore, StoreError};

pub const NOTE_FILES_DIR: &str = "attachments/notes";
pub const MAX_NOTE_FILE_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_NOTE_BATCH_BYTES: usize = 30 * 1024 * 1024;
pub const MAX_NOTE_FILES: usize = 30;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteFolder {
    id: String,
    name: String,
    application_id: Option<String>,
    company: Option<String>,
    position: Option<String>,
    application_recycled: bool,
    recycled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    id: String,
    folder_id: String,
    title: String,
    record_date: String,
    plain_text: String,
    favorite: bool,
    recycled: bool,
    files: Vec<NoteFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteFile {
    id: String,
    name: String,
    mime: String,
    ocr_text: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteIndex {
    epoch: String,
    folders: Vec<NoteFolder>,
    notes: Vec<NoteSummary>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDraft {
    pub id: String,
    pub folder_id: String,
    pub title: String,
    pub record_date: String,
    pub body: String,
    pub plain_text: String,
    pub file_ids: Vec<String>,
}

pub struct NoteUpload {
    pub id: String,
    pub name: String,
    pub bytes: Vec<u8>,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum NoteChange {
    Folder {
        id: Option<String>,
        name: String,
        application_id: Option<String>,
    },
    RecycleFolder {
        id: String,
        recycled: bool,
    },
    RecycleNote {
        id: String,
        recycled: bool,
    },
    Favorite {
        id: String,
        favorite: bool,
    },
    Move {
        id: String,
        folder_id: String,
    },
    Ocr {
        id: String,
        text: String,
    },
}

fn invalid(message: &str) -> StoreError {
    StoreError::Validation(message.into())
}

fn missing() -> StoreError {
    StoreError::NotFound("心得或文件夹已不存在。".into())
}

pub(crate) fn file_path(id: &str) -> Result<String, StoreError> {
    if !is_uuid(id) {
        return Err(invalid("无效的心得附件标识。"));
    }
    Ok(format!("{NOTE_FILES_DIR}/{id}"))
}

pub fn note_file_mime(bytes: &[u8]) -> Option<&'static str> {
    match crate::resume_files::sniff_resume_file(bytes) {
        Some(mime @ ("image/png" | "image/jpeg" | "application/pdf")) => Some(mime),
        _ if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") => Some("image/webp"),
        _ if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") => Some("image/gif"),
        _ => None,
    }
}

fn live_folder(conn: &Connection, id: &str) -> Result<(), StoreError> {
    conn.query_row(
        "SELECT 1 FROM note_folders WHERE id=?1 AND recycled=0",
        [id],
        |_| Ok(()),
    )
    .optional()?
    .ok_or_else(missing)
}

impl ArchiveStore {
    pub fn check_notes_epoch(&self, epoch: &str) -> Result<(), StoreError> {
        if self.identity().restore_epoch != epoch {
            return Err(StoreError::Conflict("档案已更换，请重新打开心得。".into()));
        }
        Ok(())
    }

    pub fn note_index(&self) -> Result<NoteIndex, StoreError> {
        let conn = self.conn();
        let mut folders = conn.prepare(
            "SELECT f.id,f.name,f.application_id,a.company,a.title,a.recycle_state='recycled',f.recycled
             FROM note_folders f LEFT JOIN applications a ON a.id=f.application_id ORDER BY f.name,f.id",
        )?;
        let folders = folders
            .query_map([], |row| {
                Ok(NoteFolder {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    application_id: row.get(2)?,
                    company: row.get(3)?,
                    position: row.get(4)?,
                    application_recycled: row.get::<_, Option<bool>>(5)?.unwrap_or(false),
                    recycled: row.get(6)?,
                })
            })?
            .collect::<Result<_, _>>()?;
        let mut stmt =
            conn.prepare("SELECT note_id,id,name,mime,ocr_text FROM note_files ORDER BY rowid")?;
        let mut files: HashMap<String, Vec<NoteFile>> = HashMap::new();
        for item in stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                NoteFile {
                    id: row.get(1)?,
                    name: row.get(2)?,
                    mime: row.get(3)?,
                    ocr_text: row.get(4)?,
                },
            ))
        })? {
            let (note, file) = item?;
            files.entry(note).or_default().push(file);
        }
        let mut stmt = conn.prepare(
            "SELECT id,folder_id,title,record_date,plain_text,favorite,recycled FROM interview_notes
             ORDER BY record_date DESC,created_at DESC,id",
        )?;
        let notes = stmt
            .query_map([], |row| {
                let id = row.get::<_, String>(0)?;
                Ok(NoteSummary {
                    files: files.remove(&id).unwrap_or_default(),
                    id,
                    folder_id: row.get(1)?,
                    title: row.get(2)?,
                    record_date: row.get(3)?,
                    plain_text: row.get(4)?,
                    favorite: row.get(5)?,
                    recycled: row.get(6)?,
                })
            })?
            .collect::<Result<_, _>>()?;
        Ok(NoteIndex {
            epoch: self.identity().restore_epoch,
            folders,
            notes,
        })
    }

    pub fn note_body(&self, id: &str) -> Result<String, StoreError> {
        self.conn()
            .query_row(
                "SELECT body FROM interview_notes WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(missing)
    }

    pub fn change_note(&self, change: NoteChange) -> Result<Option<String>, StoreError> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let (affected, result) = match change {
            NoteChange::Folder {
                id,
                name,
                application_id,
            } => {
                let name = name.trim();
                if name.is_empty() || name.chars().count() > 200 {
                    return Err(invalid("文件夹名称应为 1 到 200 字。"));
                }
                let existing_id = id.as_deref();
                if let Some(application) = &application_id {
                    let state: Option<String> = tx
                        .query_row(
                            "SELECT recycle_state FROM applications WHERE id=?1",
                            [application],
                            |r| r.get(0),
                        )
                        .optional()?;
                    let unchanged: bool = tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM note_folders WHERE id=?1 AND application_id=?2)",
                        params![existing_id, application], |r| r.get(0),
                    )?;
                    if state.as_deref() != Some("active") && !unchanged {
                        return Err(invalid("请选择一条进行中的申请。"));
                    }
                    let occupied: bool = tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM note_folders WHERE application_id=?1 AND recycled=0
                         AND id<>COALESCE(?2,''))", params![application, existing_id], |r| r.get(0),
                    )?;
                    if occupied {
                        return Err(StoreError::Conflict("该申请已有心得文件夹。".into()));
                    }
                }
                if let Some(id) = id {
                    (tx.execute("UPDATE note_folders SET name=?2,application_id=?3 WHERE id=?1 AND recycled=0",
                        params![id,name,application_id])?, Some(id))
                } else {
                    let id = new_uuid();
                    (
                        tx.execute(
                            "INSERT INTO note_folders(id,name,application_id) VALUES(?1,?2,?3)",
                            params![id, name, application_id],
                        )?,
                        Some(id),
                    )
                }
            }
            NoteChange::RecycleFolder { id, recycled } => {
                // A replacement folder may have claimed the application while this folder was recycled.
                // Restore the notes and leave that newer association in place.
                (tx.execute(
                    "UPDATE note_folders SET recycled=?2, application_id=CASE WHEN ?2=0 AND EXISTS(
                      SELECT 1 FROM note_folders active WHERE active.application_id=note_folders.application_id
                      AND active.recycled=0 AND active.id<>?1) THEN NULL ELSE application_id END WHERE id=?1",
                    params![id,recycled],
                )?, None)
            }
            NoteChange::RecycleNote { id, recycled } => (
                tx.execute(
                    "UPDATE interview_notes SET recycled=?2 WHERE id=?1",
                    params![id, recycled],
                )?,
                None,
            ),
            NoteChange::Favorite { id, favorite } => (
                tx.execute(
                    "UPDATE interview_notes SET favorite=?2 WHERE id=?1 AND recycled=0",
                    params![id, favorite],
                )?,
                None,
            ),
            NoteChange::Move { id, folder_id } => {
                live_folder(&tx, &folder_id)?;
                (
                    tx.execute(
                        "UPDATE interview_notes SET folder_id=?2 WHERE id=?1 AND recycled=0",
                        params![id, folder_id],
                    )?,
                    None,
                )
            }
            NoteChange::Ocr { id, text } => {
                if text.len() > 512 * 1024 {
                    return Err(invalid("识别文字过长。"));
                }
                (
                    tx.execute(
                        "UPDATE note_files SET ocr_text=?2 WHERE id=?1 AND mime LIKE 'image/%'",
                        params![id, text],
                    )?,
                    None,
                )
            }
        };
        if affected == 0 {
            return Err(missing());
        }
        tx.commit()?;
        Ok(result)
    }

    pub fn save_note(&self, draft: NoteDraft, uploads: Vec<NoteUpload>) -> Result<(), StoreError> {
        if !is_uuid(&draft.id)
            || draft.title.chars().count() > 200
            || draft.body.len() > 1024 * 1024
            || draft.plain_text.len() > 1024 * 1024
        {
            return Err(invalid("心得内容过长或格式无效。"));
        }
        time::Date::parse(&draft.record_date, date_format())
            .map_err(|_| invalid("请选择有效的记录日期。"))?;
        if draft.file_ids.len() > MAX_NOTE_FILES
            || uploads.len() > MAX_NOTE_FILES
            || uploads.iter().map(|file| file.bytes.len()).sum::<usize>() > MAX_NOTE_BATCH_BYTES
        {
            return Err(invalid("单篇最多 30 个附件，每次最多保存 30 MB 新附件。"));
        }
        let wanted: HashSet<_> = draft.file_ids.iter().collect();
        let upload_ids: HashSet<_> = uploads.iter().map(|file| &file.id).collect();
        if wanted.len() != draft.file_ids.len() || upload_ids.len() != uploads.len() {
            return Err(invalid("心得附件标识重复。"));
        }

        let mut conn = self.conn();
        let tx = conn.transaction()?;
        live_folder(&tx, &draft.folder_id)?;
        let existing: Option<(String, bool)> = tx
            .query_row(
                "SELECT folder_id,recycled FROM interview_notes WHERE id=?1",
                [&draft.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if existing
            .as_ref()
            .is_some_and(|(folder, recycled)| *recycled || *folder != draft.folder_id)
        {
            return Err(StoreError::Conflict(
                "心得已移动或回收，请重新打开。".into(),
            ));
        }
        let current = {
            let mut stmt = tx.prepare("SELECT id FROM note_files WHERE note_id=?1")?;
            let rows = stmt.query_map([&draft.id], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<HashSet<_>, _>>()?
        };
        if !wanted
            .iter()
            .all(|id| current.contains(*id) || upload_ids.contains(*id))
        {
            return Err(invalid("找不到正文引用的附件。"));
        }
        let removed = current
            .iter()
            .filter(|id| !wanted.contains(id))
            .map(|id| file_path(id))
            .collect::<Result<Vec<_>, _>>()?;
        let root = self.archive_dir();
        ensure_file_boundary(root)?;

        tx.execute(
            "INSERT INTO interview_notes(id,folder_id,title,record_date,body,plain_text,created_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET
             title=excluded.title,record_date=excluded.record_date,body=excluded.body,plain_text=excluded.plain_text",
            params![draft.id,draft.folder_id,draft.title.trim(),draft.record_date,draft.body,draft.plain_text,now_utc()],
        )?;
        let mut staged = Vec::new();
        for file in uploads {
            let rel = file_path(&file.id)?;
            if !wanted.contains(&file.id) || file.bytes.len() > MAX_NOTE_FILE_BYTES {
                return Err(invalid("附件未用于正文，或超过 10 MB。"));
            }
            let mime = note_file_mime(&file.bytes)
                .ok_or_else(|| invalid("请选择 PNG、JPG、GIF、WebP 或 PDF。"))?;
            let sha = format!("{:x}", Sha256::digest(&file.bytes));
            let name: String = file.name.chars().take(200).collect();
            // A retried save may include bytes already committed under this ID. Never replace them.
            let previous: Option<(String, String)> = tx
                .query_row(
                    "SELECT note_id,sha256 FROM note_files WHERE id=?1",
                    [&file.id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if let Some((note_id, hash)) = previous {
                if note_id != draft.id || hash != sha {
                    return Err(invalid("附件标识已被使用。"));
                }
                continue;
            }
            tx.execute("INSERT INTO note_files(id,note_id,name,mime,size_bytes,sha256) VALUES(?1,?2,?3,?4,?5,?6)",
                params![file.id,draft.id,name,mime,file.bytes.len() as i64,sha])?;
            staged.push((rel, file.bytes));
        }
        for id in &current {
            if !wanted.contains(id) {
                tx.execute("DELETE FROM note_files WHERE id=?1", [id])?;
            }
        }
        let committed = (|| -> Result<(), StoreError> {
            for (rel, bytes) in &staged {
                let target = root.join(rel);
                let partial = target.with_file_name(format!(
                    ".{}.partial",
                    target.file_name().unwrap().to_string_lossy()
                ));
                refuse_special_file(&target)?;
                refuse_special_file(&partial)?;
                // An orphan under this ID may remain after a process crash.
                write_atomically(root, rel, bytes)?;
            }
            tx.commit()?;
            Ok(())
        })();
        if committed.is_err() {
            for (rel, _) in &staged {
                let _ = std::fs::remove_file(root.join(rel));
            }
        } else {
            for rel in removed {
                let _ = std::fs::remove_file(root.join(rel));
            }
        }
        committed
    }

    /// Only clean our own managed files. An uncommitted write may leave an image or a
    /// partial behind; archived and recycled notes remain referenced.
    pub(crate) fn clean_interrupted_note_writes(&self) -> Result<(), StoreError> {
        let root = self.archive_dir();
        ensure_file_boundary(root)?;
        let entries = match std::fs::read_dir(root.join(NOTE_FILES_DIR)) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        let conn = self.conn();
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            let (id, partial) = match name
                .strip_prefix('.')
                .and_then(|s| s.strip_suffix(".partial"))
            {
                Some(id) => (id, true),
                None => (name, false),
            };
            if !is_uuid(id) || !entry.file_type().is_ok_and(|kind| kind.is_file()) {
                continue;
            }
            let referenced = !partial
                && conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM note_files WHERE id=?1)",
                    [id],
                    |row| row.get::<_, bool>(0),
                )?;
            if !referenced {
                let _ = std::fs::remove_file(entry.path());
            }
        }
        Ok(())
    }

    pub fn verify_note_files(&self) -> Result<(), StoreError> {
        let ids = {
            let conn = self.conn();
            let mut stmt = conn.prepare("SELECT id FROM note_files")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for id in ids {
            self.read_note_file(&id)?;
        }
        Ok(())
    }

    pub fn read_note_file(&self, id: &str) -> Result<(String, String, Vec<u8>), StoreError> {
        let rel = file_path(id)?;
        let (name, mime, sha): (String, String, String) = self
            .conn()
            .query_row(
                "SELECT name,mime,sha256 FROM note_files WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or_else(missing)?;
        ensure_file_boundary(self.archive_dir())?;
        let path = self.archive_dir().join(rel);
        refuse_special_file(&path)?;
        let mut bytes = Vec::new();
        std::fs::File::open(path)?
            .take(MAX_NOTE_FILE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > MAX_NOTE_FILE_BYTES
            || note_file_mime(&bytes) != Some(mime.as_str())
            || format!("{:x}", Sha256::digest(&bytes)) != sha
        {
            return Err(invalid("心得附件已损坏。"));
        }
        Ok((name, mime, bytes))
    }
}

fn ensure_file_boundary(root: &std::path::Path) -> Result<(), StoreError> {
    for part in ["attachments", NOTE_FILES_DIR] {
        match std::fs::symlink_metadata(root.join(part)) {
            Ok(meta) if !meta.is_dir() => return Err(invalid("心得附件目录不是普通目录。")),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn refuse_special_file(path: &std::path::Path) -> Result<(), StoreError> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if !meta.is_file() => Err(invalid("心得附件路径不是普通文件。")),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}
