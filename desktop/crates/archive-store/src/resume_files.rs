//! #429：网申时上传的文件——简历附件、证件照、成绩单和其他材料。
//!
//! 字节放在档案目录的 `attachments/resume-files/<sha256>`，同样的内容只存一份（`sha256` 唯一），
//! 跟着备份走。写入先落到 `tmp/`（不进备份），刷盘后改名到位，再用一个短事务登记：文件操作都不在数据库
//! 事务里。这个目录只归这张表管，没人引用的文件（崩溃、改名后登记失败留下的）在下一次增删时清掉。
//! 不进 `attachment_blobs`：
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

/// 按文件头认类型。只认五种：PDF；Word 97-2003（OLE 复合文档的目录里有 WordDocument 流）；
/// Word 2007 起的 DOCX（ZIP 目录里有 `[Content_Types].xml` 和 `word/document.xml` 两个条目）；JPEG；PNG。
/// Excel、PPT、Outlook 邮件这些同样是 OLE 或 ZIP，但不是这几种，不收；带宏的 Word（改了扩展名的
/// DOCM）也不收。只看文件结构里的条目名，不看内容里有没有这几个字。
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
        return has_word_stream(bytes).then_some(DOC);
    }
    if bytes.starts_with(b"PK\x03\x04") {
        let names = zip_entry_names(bytes)?;
        let has = |name: &[u8]| names.contains(&name);
        return (has(b"[Content_Types].xml") && has(b"word/document.xml") && !has(b"word/vbaProject.bin")).then_some(DOCX);
    }
    None
}

/// OLE 复合文档的目录项是 128 字节一个，在文件里按 128 字节对齐（扇区从 512 起）：开头是 UTF-16 的名字
/// （带结尾的 0），第 64 字节是名字的字节数（含结尾），第 66 字节是类型（2 是流）。
fn has_word_stream(bytes: &[u8]) -> bool {
    let name: Vec<u8> = "WordDocument\0".encode_utf16().flat_map(u16::to_le_bytes).collect();
    (512..bytes.len()).step_by(128).any(|at| {
        bytes.get(at..at + name.len()) == Some(&name[..])
            && bytes.get(at + 64..at + 66) == Some(&[name.len() as u8, 0][..])
            && bytes.get(at + 66) == Some(&2)
    })
}

/// ZIP 中央目录里的全部条目名。目录读不全（截断、ZIP64 之类）时返回 None：认不出就不收。
fn zip_entry_names(bytes: &[u8]) -> Option<Vec<&[u8]>> {
    const END: [u8; 4] = [b'P', b'K', 5, 6];
    const ENTRY: [u8; 4] = [b'P', b'K', 1, 2];
    let u16_at = |at: usize| bytes.get(at..at + 2).map(|b| u16::from_le_bytes([b[0], b[1]]) as usize);
    let u32_at = |at: usize| bytes.get(at..at + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize);
    // 目录结尾记录 22 字节，后面最多跟 65535 字节的注释。注释里也可能出现这串签名，所以只认注释长度
    // 正好延伸到文件末尾的那一条。
    let last = bytes.len().checked_sub(22)?;
    let end = (last.saturating_sub(65535)..=last)
        .rev()
        .find(|&at| bytes[at..at + 4] == END && u16_at(at + 20) == Some(bytes.len() - at - 22))?;
    let (count, offset) = (u16_at(end + 10)?, u32_at(end + 16)?);
    if count == 0xFFFF || offset == 0xFFFF_FFFF {
        return None;
    }
    let mut names = Vec::with_capacity(count);
    let mut at = offset;
    for _ in 0..count {
        if bytes.get(at..at + 4)? != ENTRY {
            return None;
        }
        let (name, extra, comment) = (u16_at(at + 28)?, u16_at(at + 30)?, u16_at(at + 32)?);
        names.push(bytes.get(at + 46..at + 46 + name)?);
        at += 46 + name + extra + comment;
    }
    Some(names)
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
    let Some(wanted) = extensions(mime).first() else {
        return Err(invalid("这个文件的类型认不出，不能改名。"));
    };
    let ext = name.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase()).unwrap_or_default();
    if !extensions(mime).contains(&ext.as_str()) {
        return Err(invalid(format!("文件内容是{}，文件名要以 .{wanted} 结尾。", type_name(mime))));
    }
    Ok(())
}

/// 添加文件时用的文件名：取原文件名，没有扩展名就按内容补上，太长就截短前面那段。
/// 扩展名和内容对不上的不收：网站常按扩展名判断类型，传上去会被拒。
fn name_for_import(original: &str, mime: &str) -> Result<String, StoreError> {
    let base = original.rsplit(['/', '\\']).next().unwrap_or("").trim();
    let Some(&wanted) = extensions(mime).first() else {
        return Err(invalid("这个文件的类型认不出，没有添加。"));
    };
    // 只有扩展名的（「.pdf」）前面那段是空的，下面补成「文件」。
    let (stem, ext) = match base.rsplit_once('.') {
        Some((stem, ext)) => (stem.trim().to_string(), ext.to_ascii_lowercase()),
        None => (base.to_string(), String::new()),
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

/// 记录里的存储位置只能是 `attachments/resume-files/<这一行的 64 位十六进制哈希>`。改过、坏掉的记录
/// （绝对路径、带 `..`、别的目录）拿去拼路径会读写档案以外的文件，所以对不上就当损坏，不动任何文件。
/// 备份清单、完整性检查也用这一条：位置不对的记录不进清单。
pub(crate) fn stored_where_expected(rel: &str, sha256: &str) -> bool {
    is_sha256(sha256) && rel == rel_path(sha256)
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 先写到档案的 `tmp/`（不进备份），刷到盘上，再改名到位。同样的内容已经在了就不再写；
/// 这个位置上有一份内容不同的旧文件（没有记录引用它，同样的哈希只登记一次）就先删掉再写。
/// 返回这次是不是新放进去的文件：登记失败时调用方要把它删掉。
fn place_file(archive_dir: &Path, rel: &str, bytes: &[u8]) -> Result<bool, StoreError> {
    let target = archive_dir.join(rel);
    if target.is_file() {
        let same = std::fs::metadata(&target).is_ok_and(|m| m.len() == bytes.len() as u64)
            && std::fs::read(&target).map(|existing| existing == bytes).unwrap_or(false);
        if same {
            return Ok(false);
        }
        if remove_verified(&target).is_err() {
            return Err(invalid("附件目录里有一份同名的旧文件正被别的程序占用，没有添加。关掉占用它的程序后再试。"));
        }
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

/// 表里一行的原样，种类和模板绑定还没解析。
struct RawFile {
    file: ResumeFile,
    kind: String,
    templates: String,
    rel: String,
}

fn raw_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawFile> {
    Ok(RawFile {
        file: ResumeFile {
            id: row.get(0)?,
            kind: ResumeFileKind::Other,
            name: row.get(2)?,
            label: row.get(3)?,
            mime: row.get(4)?,
            byte_size: row.get(5)?,
            sha256: row.get(6)?,
            is_default: row.get::<_, i64>(7)? == 1,
            template_ids: Vec::new(),
            created_at: row.get(9)?,
            updated_at: row.get(10)?,
        },
        kind: row.get(1)?,
        templates: row.get(8)?,
        rel: row.get(11)?,
    })
}

/// 读不出来的一条记录。不列进能用的文件，也不交给插件；界面上列出来，只能删掉这一行。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DamagedResumeFile {
    pub id: String,
    pub name: String,
    pub reason: String,
}

/// 「附件」页要的：能用的文件，和读不出来的记录。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeFileListing {
    pub files: Vec<ResumeFile>,
    pub damaged: Vec<DamagedResumeFile>,
}

/// 删一个附件的结果。记录删掉了就算成功，其余几项照实说没清干净的地方：
/// - `stuck_in_tmp`：这次删的文件挪进了 `tmp/`，却删不掉（被别的程序占着之类），相对档案根的位置。
///   `tmp/` 不进备份，下一次清理会再删，但文件还在磁盘上。
/// - `leftovers`：清理之后附件目录里备份清单不收的文件（相对档案根），备份会因为它们停下。
/// - `unchecked`：核对附件目录时出的错，不当成已经清干净。原始错误，给界面前要转成能给人看的说法。
#[derive(Debug, Default)]
pub struct ResumeFileDeletion {
    pub deleted: bool,
    pub stuck_in_tmp: Option<String>,
    pub leftovers: Vec<String>,
    pub unchecked: Option<StoreError>,
}

/// 存储位置不对、种类认不出、大小或类型不对、模板绑定读不出的记录不猜：拿去拼路径会读写档案以外的文件，
/// 当成「其他材料」「所有模板」会把文件用到用户没让用的地方。这样的记录单独列出来，不当文件用。
fn parse_row(raw: RawFile) -> Result<(ResumeFile, String), DamagedResumeFile> {
    let damaged = |reason: &str| DamagedResumeFile { id: raw.file.id.clone(), name: raw.file.name.clone(), reason: reason.into() };
    if !stored_where_expected(&raw.rel, &raw.file.sha256) {
        return Err(damaged("存储位置不对"));
    }
    let kind = ResumeFileKind::parse(&raw.kind).ok_or_else(|| damaged("种类认不出"))?;
    if !(1..=MAX_RESUME_FILE_BYTES as i64).contains(&raw.file.byte_size) {
        return Err(damaged("文件大小不对"));
    }
    if raw.file.mime.is_empty() {
        return Err(damaged("没有文件类型"));
    }
    if !kind.allows(&raw.file.mime) {
        return Err(damaged("文件类型不对"));
    }
    // 删掉的模板的 id 留着：只绑了它的文件不用于别的模板，等用户重新选。协议里的模板 id 是带连字符的
    // 36 位写法，别的写法这里就挡下，免得整个列表发不出去。
    let template_ids: Vec<String> = serde_json::from_str(&raw.templates)
        .ok()
        .filter(|ids: &Vec<String>| ids.len() <= MAX_TEMPLATES && ids.iter().all(|id| id.len() == 36 && crate::identity::is_uuid(id)))
        .ok_or_else(|| damaged("模板绑定读不出"))?;
    Ok((ResumeFile { kind, template_ids, ..raw.file }, raw.rel))
}

fn damaged_error(damaged: DamagedResumeFile) -> StoreError {
    StoreError::Internal(format!("附件「{}」的记录读不出来（{}），为了不用错文件，没有读写它。", damaged.name, damaged.reason))
}

const FILE_COLUMNS: &str =
    "id, kind, name, label, mime, byte_size, sha256, is_default, template_ids_json, created_at, updated_at, stored_rel_path";

impl StoreTx<'_> {
    fn template_ids_now(&self) -> Result<std::collections::HashSet<String>, StoreError> {
        let mut stmt = self.conn().prepare("SELECT id FROM resume_templates")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// 能用的记录和读不出来的记录，分开给。
    fn resume_file_rows(&self) -> Result<(Vec<(ResumeFile, String)>, Vec<DamagedResumeFile>), StoreError> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {FILE_COLUMNS} FROM resume_files \
             ORDER BY CASE kind WHEN 'resume' THEN 0 WHEN 'photo' THEN 1 WHEN 'transcript' THEN 2 ELSE 3 END, position, rowid"
        ))?;
        let rows = stmt.query_map([], raw_row)?.collect::<Result<Vec<_>, _>>()?;
        let (mut files, mut damaged) = (Vec::new(), Vec::new());
        for row in rows {
            match parse_row(row) {
                Ok(found) => files.push(found),
                Err(bad) => damaged.push(bad),
            }
        }
        Ok((files, damaged))
    }

    /// 能用的文件：按简历附件、证件照、成绩单、其他材料分好，每类按添加的先后。读不出来的记录不在里面。
    pub fn resume_files(&self) -> Result<Vec<ResumeFile>, StoreError> {
        Ok(self.resume_file_rows()?.0.into_iter().map(|(file, _)| file).collect())
    }

    pub fn resume_file_listing(&self) -> Result<ResumeFileListing, StoreError> {
        let (files, damaged) = self.resume_file_rows()?;
        Ok(ResumeFileListing { files: files.into_iter().map(|(file, _)| file).collect(), damaged })
    }

    fn resume_file_raw(&self, id: &str) -> Result<Option<RawFile>, StoreError> {
        Ok(self
            .conn()
            .query_row(&format!("SELECT {FILE_COLUMNS} FROM resume_files WHERE id = ?1"), params![id], raw_row)
            .optional()?)
    }

    /// 一条能用的记录；读不出来的按损坏报错。
    fn resume_file_row(&self, id: &str) -> Result<Option<(ResumeFile, String)>, StoreError> {
        let Some(raw) = self.resume_file_raw(id)? else {
            return Ok(None);
        };
        parse_row(raw).map(Some).map_err(damaged_error)
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

    /// 放文件之前的核对：还放得下（`replacing` 为空时）、同样的内容还没有。只读库。
    fn check_room_for(&self, sha256: &str, replacing: Option<&str>) -> Result<(), StoreError> {
        if replacing.is_none() {
            let count: i64 = self.conn().query_row("SELECT COUNT(*) FROM resume_files", [], |r| r.get(0))?;
            if count as usize >= MAX_RESUME_FILES {
                return Err(invalid(format!("附件最多存 {MAX_RESUME_FILES} 个，先删掉用不上的。")));
            }
        }
        if let Some(existing) = self.same_content(sha256, replacing)? {
            return Err(invalid(format!("这份文件已经在附件里了：「{existing}」。")));
        }
        Ok(())
    }

    /// 登记一份已经放到位的文件。这一类还没有默认的，它就是默认。
    fn register_resume_file(&mut self, kind: ResumeFileKind, name: &str, mime: &str, byte_size: usize, sha256: &str) -> Result<ResumeFile, StoreError> {
        self.check_room_for(sha256, None)?;
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
            params![id, kind.as_str(), name, mime, byte_size as i64, sha256, rel_path(sha256), i64::from(!has_default), position, now],
        )?;
        self.resume_file(&id)?.ok_or_else(|| StoreError::Internal("resume file vanished in the same transaction".into()))
    }

    /// 让记录指向一份已经放到位的新文件：说明、默认、模板不变，文件名跟着新文件走。
    /// `was` 是开始替换时的哈希：记录在这期间换过就不动。
    fn swap_resume_file(&mut self, id: &str, was: &str, name: &str, mime: &str, byte_size: usize, sha256: &str) -> Result<ResumeFile, StoreError> {
        let (current, _) = self.resume_file_row(id)?.ok_or_else(|| StoreError::NotFound(format!("resume file {id}")))?;
        if current.sha256 != was {
            return Err(StoreError::Conflict("这个附件刚在别处改过，请重新打开附件页再替换。".into()));
        }
        self.check_room_for(sha256, Some(id))?;
        self.conn().execute(
            "UPDATE resume_files SET name = ?2, mime = ?3, byte_size = ?4, sha256 = ?5, stored_rel_path = ?6, updated_at = ?7 WHERE id = ?1",
            params![id, name, mime, byte_size as i64, sha256, rel_path(sha256), now_utc()],
        )?;
        self.resume_file(id)?.ok_or_else(|| StoreError::Internal("resume file vanished in the same transaction".into()))
    }

    /// 改文件名、说明、默认和模板。新选的模板得还在；已经绑着、后来删掉的模板可以留着（界面上标「模板已删除」），
    /// 用户不取消它，就不把这条绑定变成空的「所有模板」。
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
                    if !live.contains(template) && !current.template_ids.contains(template) {
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

    fn resume_file_hash(&self, id: &str) -> Result<Option<String>, StoreError> {
        Ok(self.conn().query_row("SELECT sha256 FROM resume_files WHERE id = ?1", params![id], |r| r.get(0)).optional()?)
    }

    /// 删一条记录时要一起删的字节。没有这条记录是 `None`；有就给它的哈希，和附件目录里按这个哈希放的那份
    /// 字节的位置（相对档案根）。读不出来的记录也一样：不按它记的路径（不可信），只认按哈希放的那份。
    /// 哈希写法不对、或者别的记录还用着这个哈希时，没有要删的字节。
    fn resume_file_bytes_to_delete(&self, id: &str) -> Result<Option<(String, Option<String>)>, StoreError> {
        let Some(sha256) = self.resume_file_hash(id)? else {
            return Ok(None);
        };
        let shared: bool = self.conn().query_row(
            "SELECT EXISTS(SELECT 1 FROM resume_files WHERE sha256 = ?1 AND id <> ?2)",
            params![sha256, id],
            |r| r.get(0),
        )?;
        let rel = (is_sha256(&sha256) && !shared).then(|| rel_path(&sha256));
        Ok(Some((sha256, rel)))
    }

    /// 删记录。哈希还是开始删时的那个才删：期间换过文件就不动。
    fn forget_resume_file(&mut self, id: &str, sha256: &str) -> Result<bool, StoreError> {
        match self.resume_file_hash(id)? {
            None => Ok(false),
            Some(now) if now != sha256 => Err(StoreError::Conflict("这个附件刚在别处改过，请重新打开附件页再删。".into())),
            Some(_) => Ok(self.conn().execute("DELETE FROM resume_files WHERE id = ?1", params![id])? > 0),
        }
    }

    /// 备份清单会收的附件文件（相对档案根）：和 [ArchiveStore::backup_inventory_from_snapshot] 同一条规则，
    /// 只收存储位置对的记录。
    fn resume_file_backup_paths(&self) -> Result<std::collections::HashSet<String>, StoreError> {
        let mut stmt = self.conn().prepare("SELECT stored_rel_path, sha256 FROM resume_files")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut listed = std::collections::HashSet::new();
        for row in rows {
            let (rel, sha256) = row?;
            if stored_where_expected(&rel, &sha256) {
                listed.insert(rel);
            }
        }
        Ok(listed)
    }

    /// 清理时要留下的字节：每条记录里写法合法的 sha256 都算，不管这条记录的存储位置、种类坏没坏
    /// （位置坏了只影响读取）。只收 64 位小写十六进制，引用集合里不会混进别的文件名。
    fn referenced_resume_file_hashes(&self) -> Result<std::collections::HashSet<String>, StoreError> {
        let mut stmt = self.conn().prepare("SELECT sha256 FROM resume_files")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut referenced = std::collections::HashSet::new();
        for sha256 in rows {
            let sha256 = sha256?;
            if is_sha256(&sha256) {
                referenced.insert(sha256);
            }
        }
        Ok(referenced)
    }
}

/// 删到一半时字节放的位置：带着哈希，清理时认得出它属于哪条记录。
fn trash_for(archive_dir: &Path, rel: &str) -> std::path::PathBuf {
    let sha256 = rel.rsplit('/').next().unwrap_or_default();
    archive_dir.join("tmp").join(format!("resume-file-{sha256}.deleting"))
}

#[cfg(test)]
thread_local! {
    /// 单元测试用：让 `tmp/` 里的文件删不掉，模拟挪进去以后被别的程序占着（真文件很难稳定地做到）。
    static TMP_REMOVALS_FAIL: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// 删一个文件，被占用（杀毒软件扫描之类）时稍等再试几次。确定没了才是 `Ok`；还在、查不清，
/// 给出最后一次删除或检查的原始错误。
fn remove_verified(path: &Path) -> std::io::Result<()> {
    #[cfg(test)]
    if TMP_REMOVALS_FAIL.with(|fail| fail.get()) && path.parent().and_then(Path::file_name) == Some("tmp".as_ref()) {
        return Err(std::io::Error::other("held for the test"));
    }
    let mut last = None;
    for attempt in 0..5 {
        match std::fs::remove_file(path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                last = Some(error);
                if attempt < 4 {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
            }
            _ => break,
        }
    }
    match present(path)? {
        false => Ok(()),
        true => Err(last.unwrap_or_else(|| std::io::Error::other("the file is still there after it was removed"))),
    }
}

/// 文件在不在：确定不在是 `false`；查的时候出错（没有权限之类）照实报错，不当成不在。
fn present(path: &Path) -> std::io::Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

/// 把不再引用的字节挪进 `tmp/` 再删掉，核对原位置和临时位置都没了；没删干净就报 `message`。
fn discard(archive_dir: &Path, rel: &str, message: &str) -> Result<(), StoreError> {
    let target = archive_dir.join(rel);
    let trash = trash_for(archive_dir, rel);
    // 查不清在不在的也照删除处理，最后由 remove_verified 确认真的没了。
    if !matches!(present(&target), Ok(false)) {
        std::fs::create_dir_all(archive_dir.join("tmp"))?;
        if std::fs::rename(&target, &trash).is_err() && remove_verified(&target).is_err() {
            return Err(StoreError::Io(std::io::Error::other(message.to_string())));
        }
    }
    if !matches!(present(&trash), Ok(false)) && remove_verified(&trash).is_err() {
        return Err(StoreError::Io(std::io::Error::other(message.to_string())));
    }
    Ok(())
}

impl ArchiveStore {
    pub fn resume_files(&self) -> Result<Vec<ResumeFile>, StoreError> {
        self.transaction(|tx| tx.resume_files())
    }

    pub fn resume_file_listing(&self) -> Result<ResumeFileListing, StoreError> {
        self.transaction(|tx| tx.resume_file_listing())
    }

    pub fn resume_file(&self, id: &str) -> Result<Option<ResumeFile>, StoreError> {
        self.transaction(|tx| tx.resume_file(id))
    }

    /// 附件的增、换、删和清理拿着这把锁做，一次只做一件。文件的写入、刷盘、改名、删除和被占用时的
    /// 等待都在数据库事务外面，事务只用来核对和登记，不占着档案库。
    fn lock_resume_files(&self) -> std::sync::MutexGuard<'_, ()> {
        self.resume_file_writes.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 添加一个文件：先核对，再在事务外把文件放到位，最后用一个短事务登记；登记失败删掉刚放的文件。
    /// 之后清一次没人引用的字节，添加失败也清：失败可能正是被一份残留挡住的。
    pub fn add_resume_file(&self, kind: ResumeFileKind, original_name: &str, bytes: &[u8]) -> Result<ResumeFile, StoreError> {
        let _writes = self.lock_resume_files();
        let added = (|| {
            let mime = check_content(kind, bytes)?;
            let name = name_for_import(original_name, mime)?;
            let sha256 = sha256_hex(bytes);
            self.transaction(|tx| tx.check_room_for(&sha256, None))?;
            let rel = rel_path(&sha256);
            let placed = place_file(self.archive_dir(), &rel, bytes)?;
            let registered = self.transaction(|tx| tx.register_resume_file(kind, &name, mime, bytes.len(), &sha256));
            if registered.is_err() && placed {
                let _ = std::fs::remove_file(self.archive_dir().join(&rel));
            }
            registered
        })();
        self.sweep_resume_files_noting_errors();
        added
    }

    /// 换成新文件：放文件、登记和添加一样分开做。换上以后删掉旧字节并核对；旧字节没删干净时照实报错
    /// （新文件已经换上了）。
    pub fn replace_resume_file(&self, id: &str, original_name: &str, bytes: &[u8]) -> Result<ResumeFile, StoreError> {
        let _writes = self.lock_resume_files();
        let replaced = (|| -> Result<(ResumeFile, Option<String>), StoreError> {
            let (current, before) = self
                .transaction(|tx| tx.resume_file_row(id))?
                .ok_or_else(|| StoreError::NotFound(format!("resume file {id}")))?;
            let mime = check_content(current.kind, bytes)?;
            let name = name_for_import(original_name, mime)?;
            let sha256 = sha256_hex(bytes);
            if sha256 == current.sha256 {
                return Ok((current, None));
            }
            self.transaction(|tx| tx.check_room_for(&sha256, Some(id)))?;
            let rel = rel_path(&sha256);
            let placed = place_file(self.archive_dir(), &rel, bytes)?;
            let swapped = self.transaction(|tx| tx.swap_resume_file(id, &current.sha256, &name, mime, bytes.len(), &sha256));
            if swapped.is_err() && placed {
                let _ = std::fs::remove_file(self.archive_dir().join(&rel));
            }
            Ok((swapped?, Some(before)))
        })();
        self.sweep_resume_files_noting_errors();
        let (replaced, before) = replaced?;
        if let Some(old) = before {
            discard(self.archive_dir(), &old, "已换成新文件，但旧文件正被别的程序占用，还没从磁盘上删掉；下次增删附件时会再清一次。")?;
        }
        Ok(replaced)
    }

    pub fn update_resume_file(&self, id: &str, patch: &ResumeFilePatch) -> Result<ResumeFile, StoreError> {
        self.transaction(|tx| tx.update_resume_file(id, patch))
    }

    /// 删一个附件。能用的记录和读不出来的记录走同一条路，要删的字节只认附件目录里按哈希放的那份
    /// （读不出来的记录记的路径不可信，不拿来动文件；别的记录还用着这个哈希就不动）：
    /// - 在事务外先把字节挪进 `tmp/`（不进备份）。挪不动（被别的程序占着）、查不清它在不在，就什么都不删、
    ///   照实报错。
    /// - 再用一个短事务删记录，删不掉就把字节挪回去。
    /// - 提交以后删掉挪走的字节，再清一次残留。
    ///
    /// 记录删掉了就算成功。挪走的字节删不掉（卡在 `tmp/` 里）写在结果里；清理之后按备份清单的规则核对
    /// 附件目录，还有会让备份停下的残留也列在结果里；核对本身出错也写在结果里，不当成已经清干净。
    pub fn delete_resume_file(&self, id: &str) -> Result<ResumeFileDeletion, StoreError> {
        let _writes = self.lock_resume_files();
        let Some((sha256, rel)) = self.transaction(|tx| tx.resume_file_bytes_to_delete(id))? else {
            return Ok(ResumeFileDeletion::default());
        };
        let mut moved = None;
        if let Some(rel) = rel {
            let target = self.archive_dir().join(&rel);
            if present(&target)? {
                let trash = trash_for(self.archive_dir(), &rel);
                std::fs::create_dir_all(self.archive_dir().join("tmp"))?;
                std::fs::rename(&target, &trash).map_err(|_| invalid("文件正被别的程序占用，没有删除。关掉占用它的程序后再删一次。"))?;
                moved = Some((target, trash));
            }
        }
        let deleted = self.transaction(|tx| tx.forget_resume_file(id, &sha256));
        if let (Err(_), Some((target, trash))) = (&deleted, &moved) {
            // 记录还在：字节放回原处。挪不回去时它还叫 resume-file-<哈希>.deleting，清理时会挪回来。
            let _ = std::fs::rename(trash, target);
        }
        let deleted = deleted?;
        if let Some((_, trash)) = &moved {
            if let Err(error) = remove_verified(trash) {
                eprintln!("resume-files: trash-kept · {error}");
            }
        }
        self.sweep_resume_files_noting_errors();
        // 清理时还会再试一次；之后还在（或者查不清）的，就是卡在 tmp/ 里了。
        let stuck_in_tmp = moved.and_then(|(_, trash)| {
            (!matches!(present(&trash), Ok(false))).then(|| self.relative(&trash))
        });
        let (leftovers, unchecked) = match self.resume_file_backup_leftovers() {
            Ok(found) => (found, None),
            Err(error) => (Vec::new(), Some(error)),
        };
        Ok(ResumeFileDeletion { deleted, leftovers, stuck_in_tmp, unchecked })
    }

    /// 档案里的一个位置，相对档案根、用正斜杠。
    fn relative(&self, path: &Path) -> String {
        path.strip_prefix(self.archive_dir()).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default()
    }

    /// 附件目录里备份清单不收的文件（相对档案根）：备份会把它们当孤立文件停下。清单的规则和
    /// [ArchiveStore::backup_inventory_from_snapshot] 一样，只收存储位置对的记录。读目录出错照实报错。
    pub fn resume_file_backup_leftovers(&self) -> Result<Vec<String>, StoreError> {
        let listed = self.transaction(|tx| tx.resume_file_backup_paths())?;
        let mut leftovers = Vec::new();
        let mut walk = vec![self.archive_dir().join(RESUME_FILES_DIR)];
        while let Some(dir) = walk.pop() {
            let entries = match std::fs::read_dir(&dir) {
                Ok(entries) => entries,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            for entry in entries {
                let entry = entry?;
                if entry.file_type()?.is_dir() {
                    walk.push(entry.path());
                    continue;
                }
                let rel = self.relative(&entry.path());
                if !listed.contains(&rel) {
                    leftovers.push(rel);
                }
            }
        }
        leftovers.sort();
        Ok(leftovers)
    }

    /// 顺手的清理：失败不改变这次增删的结果（下一次增删还会再清），原始错误写进桌面日志。
    fn sweep_resume_files_noting_errors(&self) {
        if let Err(error) = self.sweep_resume_file_leftovers() {
            eprintln!("resume-files: sweep-failed · {error}");
        }
    }

    /// 清掉没人引用的字节：`attachments/resume-files/` 里没有记录引用的文件（崩溃、登记失败留下的），
    /// 以及 `tmp/` 里写到一半、删到一半留下的 `resume-file-*`。这个目录和这些临时文件只归这张表管。
    /// 删到一半的 `resume-file-<哈希>.deleting` 要是还有记录引用、原位置又没有文件（删记录失败、
    /// 挪回去也失败），就挪回原位，不当孤儿删。
    /// 调用方拿着 [Self::lock_resume_files]；只用一个短事务读引用，删文件、等待都在事务外面。
    fn sweep_resume_file_leftovers(&self) -> Result<usize, StoreError> {
        let referenced = self.transaction(|tx| tx.referenced_resume_file_hashes())?;
        let folder = self.archive_dir().join(RESUME_FILES_DIR);
        let mut removed = 0;
        for entry in std::fs::read_dir(&folder).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if entry.file_type().map(|t| t.is_file()).unwrap_or(false) && !referenced.contains(&name) {
                match remove_verified(&entry.path()) {
                    Ok(()) => removed += 1,
                    Err(error) => eprintln!("resume-files: leftover-kept · {error}"),
                }
            }
        }
        for entry in std::fs::read_dir(self.archive_dir().join("tmp")).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) || !name.starts_with("resume-file-") {
                continue;
            }
            if let Some(sha256) = name.strip_prefix("resume-file-").and_then(|rest| rest.strip_suffix(".deleting")) {
                let home = folder.join(sha256);
                if referenced.contains(sha256) && matches!(present(&home), Ok(false)) {
                    std::fs::create_dir_all(&folder)?;
                    let _ = std::fs::rename(entry.path(), &home);
                    continue;
                }
            } else if !name.ends_with(".partial") {
                continue;
            }
            match remove_verified(&entry.path()) {
                Ok(()) => removed += 1,
                Err(error) => eprintln!("resume-files: leftover-kept · {error}"),
            }
        }
        Ok(removed)
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
        // 大小和记录对不上就不读（第 0 块的整份核对也先看大小，再流式算哈希，不整份读进内存）。
        if size > MAX_RESUME_FILE_BYTES as u64
            || std::fs::metadata(self.archive_dir().join(&rel)).map(|m| m.len()).map_err(|_| damaged())? != size
        {
            return Err(damaged());
        }
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
        let damaged = || StoreError::Conflict("桌面里的这个文件和记录对不上，可能已经损坏，请重新添加。".into());
        // 先看大小：和记录对不上、或者超过上限的（被换成了别的大文件）不读进内存。
        let handle = std::fs::File::open(self.archive_dir().join(&rel)).map_err(|_| damaged())?;
        let size = handle.metadata().map_err(|_| damaged())?.len();
        if size != file.byte_size as u64 || size > MAX_RESUME_FILE_BYTES as u64 {
            return Err(damaged());
        }
        let mut bytes = Vec::with_capacity(size as usize);
        handle.take(size + 1).read_to_end(&mut bytes).map_err(|_| damaged())?;
        if bytes.len() as u64 != size || sha256_hex(&bytes) != file.sha256 {
            return Err(damaged());
        }
        Ok((file, bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bytes_that_cannot_be_removed_from_tmp_are_reported_with_the_deletion() {
        let dir = tempfile::tempdir().unwrap();
        let store = ArchiveStore::open(crate::ArchiveConfig::new(dir.path().join("archive"), dir.path().join("current.json"))).unwrap();
        let bytes = [b"%PDF-1.7\n".as_slice(), b"resume"].concat();
        let file = store.add_resume_file(ResumeFileKind::Resume, "简历.pdf", &bytes).unwrap();
        // 挪进 tmp/ 以后删不掉：记录照删，结果里写明这次的文件卡在 tmp/ 里，不报成删干净。
        TMP_REMOVALS_FAIL.with(|fail| fail.set(true));
        let result = store.delete_resume_file(&file.id);
        TMP_REMOVALS_FAIL.with(|fail| fail.set(false));
        let result = result.unwrap();
        assert!(result.deleted);
        assert_eq!(result.stuck_in_tmp.as_deref(), Some(format!("tmp/resume-file-{}.deleting", file.sha256).as_str()));
        assert!(result.leftovers.is_empty() && result.unchecked.is_none(), "{result:?}");
        assert!(store.resume_file(&file.id).unwrap().is_none());
        let trash = dir.path().join("archive").join(result.stuck_in_tmp.unwrap());
        assert!(trash.is_file());
        // 能删了以后，下一次增删附件时清掉。
        store.add_resume_file(ResumeFileKind::Photo, "照片.png", &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 1]).unwrap();
        assert!(!trash.exists());
        store.close().unwrap();
    }

    #[test]
    fn names_get_the_extension_their_content_has() {
        assert_eq!(name_for_import("C:\\Users\\a\\简历.PDF", PDF).unwrap(), "简历.pdf");
        assert_eq!(name_for_import("简历", PDF).unwrap(), "简历.pdf");
        assert_eq!(name_for_import(".pdf", PDF).unwrap(), "文件.pdf");
        assert_eq!(name_for_import("简历.", PDF).unwrap(), "简历.pdf");
        assert!(check_name("简历.zip", "application/zip").is_err());
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
