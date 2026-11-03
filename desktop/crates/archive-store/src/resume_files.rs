//! #429：网申时上传的文件——简历附件、证件照、成绩单和其他材料。
//!
//! 字节放在档案目录的 `attachments/resume-files/<sha256>`，同样的内容只存一份（`sha256` 唯一），
//! 跟着备份走。写入先落到 `tmp/`（不进备份），再改名到位，同一个事务里登记；这个目录只归这张表管，
//! 没人引用的文件（崩溃、改名后登记失败留下的）在下一次增删时清掉。不进 `attachment_blobs`：
//! 那张表的引用计数只数邮件证据，清理证据时会删掉没人引用的文件。
//!
//! 类型按文件头认，扩展名只用来核对：内容和扩展名对不上的不收。插件按块读（协议
//! `resumeFiles.read`），读第 0 块时核对一次整份哈希。

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::StoreError;
use crate::resume::MAX_TEMPLATES;
use crate::resume_secrets::is_secret_value;
use crate::store::ArchiveStore;
use crate::timeutil::now_utc;
use crate::tx::StoreTx;

/// 最多存多少个文件。文件列表要装进一条协议响应（64 KiB）。
pub const MAX_RESUME_FILES: usize = 30;
/// 单个文件的上限。网站写明的上限更小时，插件按网站的来。
pub const MAX_RESUME_FILE_BYTES: usize = 10 * 1024 * 1024;
/// 每块的字节数，和协议 `resumeFileChunkBytes` 相同。
pub const RESUME_FILE_CHUNK_BYTES: usize = 45054;
pub const MAX_RESUME_FILE_NAME_CHARS: usize = 100;
pub const MAX_RESUME_FILE_LABEL_CHARS: usize = 30;

/// 文件在档案目录里的位置，相对档案根。
pub const RESUME_FILES_DIR: &str = "attachments/resume-files";

pub const PDF: &str = "application/pdf";
pub const DOC: &str = "application/msword";
pub const DOCX: &str = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
pub const JPEG: &str = "image/jpeg";
pub const PNG: &str = "image/png";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResumeFileKind {
    /// 简历附件。
    Resume,
    /// 证件照。
    Photo,
    /// 成绩单。
    Transcript,
    /// 其他材料：作品集、证书……插件不自动传，只在用户手动指定时传。
    Other,
}

impl ResumeFileKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Resume => "resume",
            Self::Photo => "photo",
            Self::Transcript => "transcript",
            Self::Other => "other",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "resume" => Some(Self::Resume),
            "photo" => Some(Self::Photo),
            "transcript" => Some(Self::Transcript),
            "other" => Some(Self::Other),
            _ => None,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Resume => "简历附件",
            Self::Photo => "证件照",
            Self::Transcript => "成绩单",
            Self::Other => "其他材料",
        }
    }

    /// 这一类能放的类型：简历是文档，证件照是图片，成绩单两种都行，其他材料五种都行。
    /// 和协议的 `resume_file_mime_allowed` 同一口径。
    pub fn allows(self, mime: &str) -> bool {
        let allowed: &[&str] = match self {
            Self::Resume => &[PDF, DOC, DOCX],
            Self::Photo => &[JPEG, PNG],
            Self::Transcript => &[PDF, JPEG, PNG],
            Self::Other => &[PDF, DOC, DOCX, JPEG, PNG],
        };
        allowed.contains(&mime)
    }

    fn accepts(self) -> &'static str {
        match self {
            Self::Resume => "PDF、DOC、DOCX",
            Self::Photo => "JPG、PNG",
            Self::Transcript => "PDF、JPG、PNG",
            Self::Other => "PDF、DOC、DOCX、JPG、PNG",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeFile {
    pub id: String,
    pub kind: ResumeFileKind,
    /// 上传时用的文件名。
    pub name: String,
    /// 用户写的说明（「英文简历」「蓝底一寸」），没写是空串。
    pub label: String,
    pub mime: String,
    pub byte_size: i64,
    pub sha256: String,
    pub is_default: bool,
    /// 用于哪些模板；空表示所有模板。只列现在还在的模板。
    pub template_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// 一块字节和它属于的那一版文件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResumeFileChunk {
    pub file: ResumeFile,
    pub chunk_index: u32,
    pub chunk_count: u32,
    pub bytes: Vec<u8>,
}

/// 改一个文件的说明、文件名、默认和模板。没给的不变。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeFilePatch {
    pub name: Option<String>,
    pub label: Option<String>,
    pub is_default: Option<bool>,
    pub template_ids: Option<Vec<String>>,
}

const CFB_MAGIC: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
const PNG_MAGIC: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// 按文件头认类型。只认五种：PDF；Word 97-2003（OLE 复合文档里有 WordDocument 流）；
/// Word 2007 起的 DOCX（ZIP 里有 `[Content_Types].xml` 和 `word/document.xml`）；JPEG；PNG。
/// Excel、PPT、Outlook 邮件这些同样是 OLE 或 ZIP，但不是这几种，不收。
pub fn sniff_resume_file(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"%PDF-") {
        return Some(PDF);
    }
    if bytes.starts_with(&PNG_MAGIC) {
        return Some(PNG);
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some(JPEG);
    }
    if bytes.starts_with(&CFB_MAGIC) {
        let stream: Vec<u8> = "WordDocument".encode_utf16().flat_map(u16::to_le_bytes).collect();
        return contains(bytes, &stream).then_some(DOC);
    }
    if bytes.starts_with(b"PK\x03\x04") {
        return (contains(bytes, b"[Content_Types].xml") && contains(bytes, b"word/document.xml")).then_some(DOCX);
    }
    None
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|window| window == needle)
}

fn extensions(mime: &str) -> &'static [&'static str] {
    match mime {
        PDF => &["pdf"],
        DOC => &["doc"],
        DOCX => &["docx"],
        JPEG => &["jpg", "jpeg"],
        PNG => &["png"],
        _ => &[],
    }
}

fn type_name(mime: &str) -> &'static str {
    match mime {
        PDF => "PDF",
        DOC => "Word 文档（DOC）",
        DOCX => "Word 文档（DOCX）",
        JPEG => "JPG 图片",
        PNG => "PNG 图片",
        _ => "未知类型",
    }
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::Validation(message.into())
}

/// 像在写密码、口令、密钥的文字（`token=…`、`Bearer …`、`sk-…`）。文件名和说明会经协议交给插件，
/// 协议的密钥扫描会拒掉整条文件列表，所以存的时候就不收。
fn looks_like_credential(text: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?i)(?:apikey|api_key|api-key|authorization|cookie|otp)\s*[:=]\s*\S|bearer |(?:^|[^a-z0-9_-])sk-[a-z0-9_-]{17,}").unwrap()
    });
    is_secret_value(text) || re.is_match(text)
}

/// Windows 文件名里不能有的字符，网站收到这样的文件名也可能拒收。
const BAD_NAME_CHARS: &[char] = &['\\', '/', ':', '*', '?', '"', '<', '>', '|'];

/// 核对文件名：不空、不超长、没有控制字符和文件名里不能有的字符，扩展名和内容对得上。
fn check_name(name: &str, mime: &str) -> Result<(), StoreError> {
    if name.is_empty() {
        return Err(invalid("文件名不能是空的。"));
    }
    if name.chars().count() > MAX_RESUME_FILE_NAME_CHARS {
        return Err(invalid(format!("文件名太长，最多 {MAX_RESUME_FILE_NAME_CHARS} 个字。")));
    }
    if name.chars().any(char::is_control) || name.contains(BAD_NAME_CHARS) {
        return Err(invalid("文件名里不能有 \\ / : * ? \" < > | 这些字符。"));
    }
    if looks_like_credential(name) {
        return Err(invalid("文件名看起来像密码或密钥，改个名字再存。"));
    }
    let ext = name.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase()).unwrap_or_default();
    if !extensions(mime).contains(&ext.as_str()) {
        return Err(invalid(format!("文件内容是{}，文件名要以 .{} 结尾。", type_name(mime), extensions(mime)[0])));
    }
    Ok(())
}

/// 添加文件时用的文件名：取原文件名，没有扩展名就按内容补上，太长就截短前面那段。
/// 扩展名和内容对不上的不收：网站常按扩展名判断类型，传上去会被拒。
fn name_for_import(original: &str, mime: &str) -> Result<String, StoreError> {
    let base = original.rsplit(['/', '\\']).next().unwrap_or("").trim();
    let wanted = extensions(mime)[0];
    let (stem, ext) = match base.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem.trim().to_string(), ext.to_ascii_lowercase()),
        _ => (base.trim_end_matches('.').to_string(), String::new()),
    };
    if !ext.is_empty() && !extensions(mime).contains(&ext.as_str()) {
        return Err(invalid(format!("文件内容是{}，扩展名却是 .{ext}，没有添加。改好扩展名再添加。", type_name(mime))));
    }
    let ext = if ext.is_empty() { wanted.to_string() } else { ext };
    let room = MAX_RESUME_FILE_NAME_CHARS - ext.chars().count() - 1;
    let stem: String = stem.chars().take(room).collect();
    let stem = if stem.trim().is_empty() { "文件".to_string() } else { stem };
    let name = format!("{stem}.{ext}");
    check_name(&name, mime)?;
    Ok(name)
}

fn check_label(label: &str) -> Result<String, StoreError> {
    let label = label.trim().to_string();
    if label.chars().count() > MAX_RESUME_FILE_LABEL_CHARS {
        return Err(invalid(format!("说明太长，最多 {MAX_RESUME_FILE_LABEL_CHARS} 个字。")));
    }
    if label.chars().any(char::is_control) {
        return Err(invalid("说明里有看不见的控制字符，没有保存。"));
    }
    if looks_like_credential(&label) {
        return Err(invalid("说明看起来像密码或密钥，没有保存。"));
    }
    Ok(label)
}

/// 添加或替换之前对内容的核对：大小、类型、这一类能不能放。返回认出的类型。
fn check_content(kind: ResumeFileKind, bytes: &[u8]) -> Result<&'static str, StoreError> {
    if bytes.is_empty() {
        return Err(invalid("文件是空的，没有添加。"));
    }
    if bytes.len() > MAX_RESUME_FILE_BYTES {
        return Err(invalid(format!("文件超过 {} MB，没有添加。", MAX_RESUME_FILE_BYTES / 1024 / 1024)));
    }
    let mime = sniff_resume_file(bytes)
        .ok_or_else(|| invalid("只收 PDF、Word（DOC、DOCX）、JPG、PNG 文件，按文件内容认不出是这几种，没有添加。"))?;
    if !kind.allows(mime) {
        return Err(invalid(format!("{}只收 {}，这个文件是{}。", kind.label(), kind.accepts(), type_name(mime))));
    }
    Ok(mime)
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn rel_path(sha256: &str) -> String {
    format!("{RESUME_FILES_DIR}/{sha256}")
}

/// 先写到档案的 `tmp/`（不进备份），刷到盘上，再改名到位。同样的内容已经在了就不再写。
/// 返回这次是不是新放进去的文件：登记失败时调用方要把它删掉。
fn place_file(archive_dir: &Path, rel: &str, bytes: &[u8]) -> Result<bool, StoreError> {
    let target = archive_dir.join(rel);
    if target.is_file() && std::fs::read(&target).map(|existing| existing == bytes).unwrap_or(false) {
        return Ok(false);
    }
    let dir = target.parent().ok_or_else(|| StoreError::PathInvalid("resume file path has no directory".into()))?;
    std::fs::create_dir_all(dir)?;
    let tmp_dir = archive_dir.join("tmp");
    std::fs::create_dir_all(&tmp_dir)?;
    let partial = tmp_dir.join(format!("resume-file-{}.partial", uuid::Uuid::new_v4()));
    let written = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&partial)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&partial, &target)
    })();
    if let Err(error) = written {
        let _ = std::fs::remove_file(&partial);
        return Err(error.into());
    }
    #[cfg(unix)]
    std::fs::File::open(dir)?.sync_all()?;
    Ok(true)
}

fn row_to_file(row: &rusqlite::Row<'_>) -> rusqlite::Result<(ResumeFile, String)> {
    let kind: String = row.get(1)?;
    let templates: String = row.get(8)?;
    Ok((
        ResumeFile {
            id: row.get(0)?,
            kind: ResumeFileKind::parse(&kind).unwrap_or(ResumeFileKind::Other),
            name: row.get(2)?,
            label: row.get(3)?,
            mime: row.get(4)?,
            byte_size: row.get(5)?,
            sha256: row.get(6)?,
            is_default: row.get::<_, i64>(7)? == 1,
            template_ids: serde_json::from_str(&templates).unwrap_or_default(),
            created_at: row.get(9)?,
            updated_at: row.get(10)?,
        },
        row.get(11)?,
    ))
}

const FILE_COLUMNS: &str =
    "id, kind, name, label, mime, byte_size, sha256, is_default, template_ids_json, created_at, updated_at, stored_rel_path";

impl StoreTx<'_> {
    fn template_ids_now(&self) -> Result<std::collections::HashSet<String>, StoreError> {
        let mut stmt = self.conn().prepare("SELECT id FROM resume_templates")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    fn resume_file_rows(&self) -> Result<Vec<(ResumeFile, String)>, StoreError> {
        let live = self.template_ids_now()?;
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {FILE_COLUMNS} FROM resume_files \
             ORDER BY CASE kind WHEN 'resume' THEN 0 WHEN 'photo' THEN 1 WHEN 'transcript' THEN 2 ELSE 3 END, position, rowid"
        ))?;
        let rows = stmt.query_map([], row_to_file)?;
        let mut files = rows.collect::<Result<Vec<_>, _>>()?;
        for (file, _) in &mut files {
            file.template_ids.retain(|id| live.contains(id));
        }
        Ok(files)
    }

    /// 全部文件：按简历附件、证件照、成绩单、其他材料分好，每类按添加的先后。
    pub fn resume_files(&self) -> Result<Vec<ResumeFile>, StoreError> {
        Ok(self.resume_file_rows()?.into_iter().map(|(file, _)| file).collect())
    }

    fn resume_file_row(&self, id: &str) -> Result<Option<(ResumeFile, String)>, StoreError> {
        let live = self.template_ids_now()?;
        let found = self
            .conn()
            .query_row(&format!("SELECT {FILE_COLUMNS} FROM resume_files WHERE id = ?1"), params![id], row_to_file)
            .optional()?;
        Ok(found.map(|(mut file, rel)| {
            file.template_ids.retain(|id| live.contains(id));
            (file, rel)
        }))
    }

    pub fn resume_file(&self, id: &str) -> Result<Option<ResumeFile>, StoreError> {
        Ok(self.resume_file_row(id)?.map(|(file, _)| file))
    }

    fn same_content(&self, sha256: &str, except: Option<&str>) -> Result<Option<String>, StoreError> {
        Ok(self
            .conn()
            .query_row(
                "SELECT name FROM resume_files WHERE sha256 = ?1 AND id IS NOT ?2",
                params![sha256, except],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// 添加一个文件。这一类还没有默认的，它就是默认。
    pub fn add_resume_file(&mut self, kind: ResumeFileKind, original_name: &str, bytes: &[u8]) -> Result<ResumeFile, StoreError> {
        let mime = check_content(kind, bytes)?;
        let name = name_for_import(original_name, mime)?;
        let count: i64 = self.conn().query_row("SELECT COUNT(*) FROM resume_files", [], |r| r.get(0))?;
        if count as usize >= MAX_RESUME_FILES {
            return Err(invalid(format!("附件最多存 {MAX_RESUME_FILES} 个，先删掉用不上的。")));
        }
        let sha256 = sha256_hex(bytes);
        if let Some(existing) = self.same_content(&sha256, None)? {
            return Err(invalid(format!("这份文件已经在附件里了：「{existing}」。")));
        }
        let rel = rel_path(&sha256);
        let placed = place_file(&self.archive_dir, &rel, bytes)?;
        let inserted = (|| -> Result<ResumeFile, StoreError> {
            let has_default: bool = self.conn().query_row(
                "SELECT EXISTS(SELECT 1 FROM resume_files WHERE kind = ?1 AND is_default = 1)",
                params![kind.as_str()],
                |r| r.get(0),
            )?;
            let position: i64 = self.conn().query_row("SELECT COALESCE(MAX(position), 0) + 1 FROM resume_files", [], |r| r.get(0))?;
            let id = crate::identity::new_uuid();
            let now = now_utc();
            self.conn().execute(
                "INSERT INTO resume_files (id, kind, name, label, mime, byte_size, sha256, stored_rel_path, is_default, \
                 template_ids_json, position, created_at, updated_at) VALUES (?1, ?2, ?3, '', ?4, ?5, ?6, ?7, ?8, '[]', ?9, ?10, ?10)",
                params![id, kind.as_str(), name, mime, bytes.len() as i64, sha256, rel, i64::from(!has_default), position, now],
            )?;
            self.resume_file(&id)?.ok_or_else(|| StoreError::Internal("resume file vanished in the same transaction".into()))
        })();
        if inserted.is_err() && placed {
            let _ = std::fs::remove_file(self.archive_dir.join(&rel));
        }
        inserted
    }

    /// 换成另一份文件：说明、默认、模板不变，文件名跟着新文件走。
    pub fn replace_resume_file(&mut self, id: &str, original_name: &str, bytes: &[u8]) -> Result<ResumeFile, StoreError> {
        let (current, _) = self.resume_file_row(id)?.ok_or_else(|| StoreError::NotFound(format!("resume file {id}")))?;
        let mime = check_content(current.kind, bytes)?;
        let name = name_for_import(original_name, mime)?;
        let sha256 = sha256_hex(bytes);
        if sha256 == current.sha256 {
            return Ok(current);
        }
        if let Some(existing) = self.same_content(&sha256, Some(id))? {
            return Err(invalid(format!("这份文件已经在附件里了：「{existing}」。")));
        }
        let rel = rel_path(&sha256);
        let placed = place_file(&self.archive_dir, &rel, bytes)?;
        let updated = (|| -> Result<ResumeFile, StoreError> {
            self.conn().execute(
                "UPDATE resume_files SET name = ?2, mime = ?3, byte_size = ?4, sha256 = ?5, stored_rel_path = ?6, updated_at = ?7 WHERE id = ?1",
                params![id, name, mime, bytes.len() as i64, sha256, rel, now_utc()],
            )?;
            self.resume_file(id)?.ok_or_else(|| StoreError::Internal("resume file vanished in the same transaction".into()))
        })();
        if updated.is_err() && placed {
            let _ = std::fs::remove_file(self.archive_dir.join(&rel));
        }
        updated
    }

    /// 改文件名、说明、默认和模板。
    pub fn update_resume_file(&mut self, id: &str, patch: &ResumeFilePatch) -> Result<ResumeFile, StoreError> {
        let (current, _) = self.resume_file_row(id)?.ok_or_else(|| StoreError::NotFound(format!("resume file {id}")))?;
        let name = match &patch.name {
            Some(name) => {
                let name = name.trim().to_string();
                check_name(&name, &current.mime)?;
                name
            }
            None => current.name.clone(),
        };
        let label = match &patch.label {
            Some(label) => check_label(label)?,
            None => current.label.clone(),
        };
        let templates = match &patch.template_ids {
            Some(ids) => {
                let live = self.template_ids_now()?;
                let mut kept: Vec<String> = Vec::new();
                for template in ids {
                    if !live.contains(template) {
                        return Err(invalid("选的模板已经不在了，请重新选。"));
                    }
                    if !kept.contains(template) {
                        kept.push(template.clone());
                    }
                }
                if kept.len() > MAX_TEMPLATES {
                    return Err(invalid(format!("一个文件最多绑定 {MAX_TEMPLATES} 个模板。")));
                }
                kept
            }
            None => current.template_ids.clone(),
        };
        let is_default = patch.is_default.unwrap_or(current.is_default);
        if is_default && !current.is_default {
            self.conn().execute(
                "UPDATE resume_files SET is_default = 0 WHERE kind = ?1 AND is_default = 1",
                params![current.kind.as_str()],
            )?;
        }
        self.conn().execute(
            "UPDATE resume_files SET name = ?2, label = ?3, is_default = ?4, template_ids_json = ?5, updated_at = ?6 WHERE id = ?1",
            params![id, name, label, i64::from(is_default), serde_json::to_string(&templates)?, now_utc()],
        )?;
        self.resume_file(id)?.ok_or_else(|| StoreError::Internal("resume file vanished in the same transaction".into()))
    }

    /// 删一个文件的记录。文件本身在提交之后由 [ArchiveStore::delete_resume_file] 删。
    pub fn delete_resume_file_row(&mut self, id: &str) -> Result<bool, StoreError> {
        Ok(self.conn().execute("DELETE FROM resume_files WHERE id = ?1", params![id])? > 0)
    }

    /// 删掉 `attachments/resume-files/` 里没人引用的文件：崩溃、登记失败、替换和删除留下的。
    /// 这个目录只归这张表管，所以按表里有没有来判断。
    pub fn sweep_resume_file_leftovers(&mut self) -> Result<usize, StoreError> {
        let dir = self.archive_dir.join(RESUME_FILES_DIR);
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return Ok(0);
        };
        let referenced: std::collections::HashSet<String> = self
            .resume_file_rows()?
            .into_iter()
            .filter_map(|(_, rel)| rel.rsplit('/').next().map(str::to_string))
            .collect();
        let mut removed = 0;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if entry.file_type().map(|t| t.is_file()).unwrap_or(false)
                && !referenced.contains(&name)
                && std::fs::remove_file(entry.path()).is_ok()
            {
                removed += 1;
            }
        }
        Ok(removed)
    }
}

impl ArchiveStore {
    pub fn resume_files(&self) -> Result<Vec<ResumeFile>, StoreError> {
        self.transaction(|tx| tx.resume_files())
    }

    pub fn resume_file(&self, id: &str) -> Result<Option<ResumeFile>, StoreError> {
        self.transaction(|tx| tx.resume_file(id))
    }

    pub fn add_resume_file(&self, kind: ResumeFileKind, original_name: &str, bytes: &[u8]) -> Result<ResumeFile, StoreError> {
        let added = self.transaction(|tx| tx.add_resume_file(kind, original_name, bytes))?;
        let _ = self.transaction(|tx| tx.sweep_resume_file_leftovers());
        Ok(added)
    }

    pub fn replace_resume_file(&self, id: &str, original_name: &str, bytes: &[u8]) -> Result<ResumeFile, StoreError> {
        let replaced = self.transaction(|tx| tx.replace_resume_file(id, original_name, bytes))?;
        let _ = self.transaction(|tx| tx.sweep_resume_file_leftovers());
        Ok(replaced)
    }

    pub fn update_resume_file(&self, id: &str, patch: &ResumeFilePatch) -> Result<ResumeFile, StoreError> {
        self.transaction(|tx| tx.update_resume_file(id, patch))
    }

    /// 删记录，提交之后再删文件：反过来的话，提交失败会留下一条指向不存在文件的记录。
    pub fn delete_resume_file(&self, id: &str) -> Result<bool, StoreError> {
        let deleted = self.transaction(|tx| tx.delete_resume_file_row(id))?;
        let _ = self.transaction(|tx| tx.sweep_resume_file_leftovers());
        Ok(deleted)
    }

    /// 读一块。`sha256` 是请求方要的那一版：桌面里换过、删过就是 `Conflict`。
    /// 读第 0 块时核对整份文件的长度和哈希，存的内容和记录对不上也是 `Conflict`。
    pub fn read_resume_file_chunk(&self, id: &str, sha256: &str, chunk_index: u32) -> Result<ResumeFileChunk, StoreError> {
        let changed = || StoreError::Conflict("这个文件在桌面里换过或删掉了，请重新开始。".into());
        let (file, rel) = self.transaction(|tx| tx.resume_file_row(id))?.ok_or_else(changed)?;
        if file.sha256 != sha256 {
            return Err(changed());
        }
        let size = file.byte_size as u64;
        let chunk = RESUME_FILE_CHUNK_BYTES as u64;
        let chunk_count = size.div_ceil(chunk);
        if u64::from(chunk_index) >= chunk_count {
            return Err(invalid("没有这一块。"));
        }
        let damaged = || StoreError::Conflict("桌面里的这个文件和记录对不上，可能已经损坏，请在桌面重新添加。".into());
        if chunk_index == 0 {
            crate::tx::verify_file(self.archive_dir(), &rel, file.byte_size, &file.sha256).map_err(|_| damaged())?;
        }
        let start = u64::from(chunk_index) * chunk;
        let len = (size - start).min(chunk) as usize;
        let mut bytes = vec![0u8; len];
        let mut handle = std::fs::File::open(self.archive_dir().join(&rel)).map_err(|_| damaged())?;
        handle.seek(SeekFrom::Start(start)).map_err(|_| damaged())?;
        handle.read_exact(&mut bytes).map_err(|_| damaged())?;
        Ok(ResumeFileChunk { file, chunk_index, chunk_count: chunk_count as u32, bytes })
    }

    /// 读整份文件（桌面预览、用系统程序打开）。核对长度和哈希。
    pub fn read_resume_file(&self, id: &str) -> Result<(ResumeFile, Vec<u8>), StoreError> {
        let (file, rel) = self
            .transaction(|tx| tx.resume_file_row(id))?
            .ok_or_else(|| StoreError::NotFound(format!("resume file {id}")))?;
        let bytes = std::fs::read(self.archive_dir().join(&rel))?;
        if bytes.len() as i64 != file.byte_size || sha256_hex(&bytes) != file.sha256 {
            return Err(StoreError::Conflict("桌面里的这个文件和记录对不上，可能已经损坏，请重新添加。".into()));
        }
        Ok((file, bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_get_the_extension_their_content_has() {
        assert_eq!(name_for_import("C:\\Users\\a\\简历.PDF", PDF).unwrap(), "简历.pdf");
        assert_eq!(name_for_import("简历", PDF).unwrap(), "简历.pdf");
        assert_eq!(name_for_import("照片.jpeg", JPEG).unwrap(), "照片.jpeg");
        assert!(name_for_import("简历.docx", PDF).is_err());
        let long = format!("{}.pdf", "很".repeat(200));
        assert_eq!(name_for_import(&long, PDF).unwrap().chars().count(), MAX_RESUME_FILE_NAME_CHARS);
        assert!(check_name("简历.doc", DOCX).is_err());
        assert!(check_name("a:b.pdf", PDF).is_err());
        assert!(check_name("token=abc.pdf", PDF).is_err());
        assert!(check_name("密码学课程成绩单.pdf", PDF).is_ok());
    }
}
