use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{ErrorCode, Layer, ProtocolError};

pub const PROTOCOL_VERSION: u32 = 2;
pub const MIN_PROTOCOL_VERSION: u32 = 1;
pub const MAX_PROTOCOL_VERSION: u32 = 6;
pub const MAX_ENVELOPE_BYTES: usize = 65536;
pub const SUGGESTED_RAW_CHUNK_BYTES: usize = 32768;
pub const MAX_SNAPSHOT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_RECONCILE_ITEMS: usize = 32;
pub const MAX_CHUNK_COUNT: u32 = 128;
/// #429：桌面按块把简历附件、证件照交给插件。块大小是 3 的倍数，各块的 base64 能直接拼起来；
/// base64 后 60072 个字符，整条响应留着约 5 KB 余量，仍在 [MAX_ENVELOPE_BYTES] 以内。
pub const RESUME_FILE_CHUNK_BYTES: usize = 45054;
pub const MAX_RESUME_FILE_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_RESUME_FILE_CHUNK_COUNT: u32 = 233;
pub const MAX_RESUME_FILES: usize = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MessageType {
    #[serde(rename = "health")]
    Health,
    #[serde(rename = "handshake")]
    Handshake,
    #[serde(rename = "application.queryCandidates")]
    QueryCandidates,
    #[serde(rename = "job.save")]
    JobSave,
    #[serde(rename = "fill.submit")]
    FillSubmit,
    #[serde(rename = "snapshot.chunk")]
    SnapshotChunk,
    #[serde(rename = "submit.confirm")]
    SubmitConfirm,
    #[serde(rename = "outbox.reconcile")]
    OutboxReconcile,
    #[serde(rename = "resume.read")]
    ResumeRead,
    #[serde(rename = "resume.update")]
    ResumeUpdate,
    #[serde(rename = "ai.complete")]
    AiComplete,
    #[serde(rename = "ui.open")]
    UiOpen,
    #[serde(rename = "usage.touch")]
    UsageTouch,
    #[serde(rename = "usage.settings")]
    UsageSettings,
    #[serde(rename = "legacy.import")]
    LegacyImport,
    #[serde(rename = "mail.import")]
    MailImport,
    #[serde(rename = "siteAnswers.read")]
    SiteAnswersRead,
    #[serde(rename = "siteAnswers.save")]
    SiteAnswersSave,
    #[serde(rename = "resumeFiles.list")]
    ResumeFilesList,
    #[serde(rename = "resumeFiles.read")]
    ResumeFilesRead,
}

impl MessageType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Health => "health",
            Self::Handshake => "handshake",
            Self::QueryCandidates => "application.queryCandidates",
            Self::JobSave => "job.save",
            Self::FillSubmit => "fill.submit",
            Self::SnapshotChunk => "snapshot.chunk",
            Self::SubmitConfirm => "submit.confirm",
            Self::OutboxReconcile => "outbox.reconcile",
            Self::ResumeRead => "resume.read",
            Self::ResumeUpdate => "resume.update",
            Self::AiComplete => "ai.complete",
            Self::UiOpen => "ui.open",
            Self::LegacyImport => "legacy.import",
            Self::MailImport => "mail.import",
            Self::SiteAnswersRead => "siteAnswers.read",
            Self::SiteAnswersSave => "siteAnswers.save",
            Self::ResumeFilesList => "resumeFiles.list",
            Self::ResumeFilesRead => "resumeFiles.read",
            Self::UsageTouch => "usage.touch",
            Self::UsageSettings => "usage.settings",
        }
    }

    pub fn parse(value: &str) -> Result<Self, ProtocolError> {
        match value {
            "health" => Ok(Self::Health),
            "handshake" => Ok(Self::Handshake),
            "application.queryCandidates" => Ok(Self::QueryCandidates),
            "job.save" => Ok(Self::JobSave),
            "fill.submit" => Ok(Self::FillSubmit),
            "snapshot.chunk" => Ok(Self::SnapshotChunk),
            "submit.confirm" => Ok(Self::SubmitConfirm),
            "outbox.reconcile" => Ok(Self::OutboxReconcile),
            "resume.read" => Ok(Self::ResumeRead),
            "resume.update" => Ok(Self::ResumeUpdate),
            "ai.complete" => Ok(Self::AiComplete),
            "ui.open" => Ok(Self::UiOpen),
            "legacy.import" => Ok(Self::LegacyImport),
            "mail.import" => Ok(Self::MailImport),
            "siteAnswers.read" => Ok(Self::SiteAnswersRead),
            "siteAnswers.save" => Ok(Self::SiteAnswersSave),
            "resumeFiles.list" => Ok(Self::ResumeFilesList),
            "resumeFiles.read" => Ok(Self::ResumeFilesRead),
            "usage.touch" => Ok(Self::UsageTouch),
            "usage.settings" => Ok(Self::UsageSettings),
            "SaveIntent" | "saveIntent" | "save.intent" => Err(ProtocolError::new(
                ErrorCode::UnknownMessageType,
                Layer::Structure,
                "SaveIntent is a plugin-local object, not a Native Messaging messageType",
            )),
            _ => Err(ProtocolError::new(
                ErrorCode::UnknownMessageType,
                Layer::Structure,
                format!("unknown messageType {value}"),
            )),
        }
    }

    pub fn identity_forbidden(self) -> bool {
        matches!(self, Self::Health | Self::Handshake | Self::AiComplete | Self::UiOpen | Self::UsageTouch | Self::UsageSettings)
    }

    pub fn identity_required(self) -> bool {
        !self.identity_forbidden()
    }

    pub fn is_write(self) -> bool {
        matches!(
            self,
            Self::JobSave | Self::FillSubmit | Self::SnapshotChunk | Self::SubmitConfirm
        )
    }

    pub fn needs_source_restore_epoch(self) -> bool {
        self.is_write()
    }

    pub fn min_envelope_version(self) -> u32 {
        match self {
            Self::ResumeFilesList | Self::ResumeFilesRead => 6,
            Self::SiteAnswersRead | Self::SiteAnswersSave => 5,
            Self::MailImport => 4,
            Self::UsageTouch | Self::UsageSettings => 3,
            Self::ResumeRead | Self::ResumeUpdate | Self::AiComplete | Self::UiOpen | Self::LegacyImport => 2,
            _ => 1,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Request {
    pub protocol_version: u32,
    pub message_id: String,
    pub client_instance_id: String,
    pub message_type: MessageType,
    pub occurred_at: String,
    pub archive_id: Option<String>,
    pub restore_epoch: Option<String>,
    pub payload: Value,
    pub raw: Value,
}

#[derive(Debug, Clone)]
pub struct CurrentArchive {
    pub archive_id: String,
    pub restore_epoch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct MessageKey {
    pub client_instance_id: String,
    pub message_id: String,
    pub source_restore_epoch: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoredOutcome {
    Applied {
        result_id: String,
        payload_sha256: String,
    },
    Purged {
        payload_sha256: String,
    },
    Unverifiable,
}

pub trait ReceiptStore {
    fn get(&self, key: &MessageKey) -> Option<StoredOutcome>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteDecision {
    Accept,
    Replay { result_id: String },
    Conflict,
    PreviouslyPurged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReconcileStatusKind {
    Applied,
    Purged,
    NotFound,
    Conflict,
    Unverifiable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileItemResult {
    pub client_instance_id: String,
    pub message_id: String,
    pub source_restore_epoch: String,
    pub payload_sha256: String,
    pub status: ReconcileStatusKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunk_index: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AckKind {
    Chunk,
    Snapshot,
}
