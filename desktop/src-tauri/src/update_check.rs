//! 「有没有新版本」以及「应用内下载并校验安装包，经用户确认后再打开安装程序」。
//!
//! 为什么不做静默自动安装：安装包没有签名。应用内直接下载安装包时，必须先拉取配套的
//! `.sha256` 校验文件，流式下载并汇报进度，下载完成后严格比对 SHA-256 哈希；校验通过后
//! **绝不自动运行安装程序**，而是把版本、文件名和 SHA-256 交给用户确认，用户点「确认并打开
//! 安装程序」时再复核一次磁盘上的文件哈希才交由系统打开。
//!
//! 查的是 GitHub 的 releases 列表，只认 `desktop-v*` 的 tag：插件用的是
//! `v*.*.*`，两边混在同一个仓库里。GitHub 在国内时好时坏，连不上、超时、
//! 5xx 或限流时，同一页改问我们在 Cloudflare 上的中转（`services/feedback-relay`
//! 的 `/releases`，代查同一个 GitHub 地址），挑版本和校验地址的规则都不变。

use std::future::Future;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use url::Url;

use crate::commands::CommandError;

const RELEASES_URL: &str =
    "https://api.github.com/repositories/1217054301/releases";
/// GitHub 查不到时的备用来源。返回和 GitHub 同样形状的列表，每条只留挑版本用到的四个字段。
const RELAY_RELEASES_URL: &str = "https://feedback.19991107.xyz/releases";
/// 中转只认 `per_page=100` 和第 1～10 页，改这两个要一起改 `services/feedback-relay/src/releases.mjs`。
const RELEASES_PER_PAGE: usize = 100;
const RELAY_MAX_PAGE: u32 = 10;
const TAG_PREFIX: &str = "desktop-v";
const TIMEOUT_SECONDS: u64 = 10;
const DOWNLOAD_TIMEOUT_SECONDS: u64 = 300;
const FILE_NAME: &str = "update-check.json";
const INSTALLER_ASSET_PREFIX: &str = "wangshen-kuaitian";
const UPDATES_DIR_NAME: &str = "updates";
const MAX_CHECKSUM_BYTES: usize = 4096;
const MAX_INSTALLER_BYTES: u64 = 512 * 1024 * 1024;
const PROGRESS_STEP_BYTES: u64 = 64 * 1024;

/// 用户对自动检查的偏好。单独一个文件：settings.json 是整份覆盖写的。
///
/// 上次查到的版本也记在这里：一天只查一次，同一天重启以后主界面还要能接着提示，
/// 「去下载页」也还要能打开。
///
/// 主界面的提示收起只管这一次运行，不记在这里：下次打开还会提示，直到装上新版。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePreference {
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_checked_at: Option<String>,
    /// 上次查成时比当前版本新的那一版。没有更新就是空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available: Option<UpdateInfo>,
}

impl Default for UpdatePreference {
    fn default() -> Self {
        // 默认开：不知道有新版本，用户就一直停在旧版上。查一次只是一个 GET，
        // 而且每天最多一次，随时能关。
        Self {
            enabled: true,
            last_checked_at: None,
            available: None,
        }
    }
}

pub fn path_for(data_root: &Path) -> PathBuf {
    data_root.join(FILE_NAME)
}

/// 读偏好。文件坏了就退回默认：这里没有任何不可再生的数据。
pub fn load(data_root: &Path) -> UpdatePreference {
    std::fs::read_to_string(path_for(data_root))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save(data_root: &Path, pref: &UpdatePreference) -> Result<(), String> {
    let target = path_for(data_root);
    let tmp = target.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(pref).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| format!("写 {} 失败：{e}", tmp.display()))?;
    std::fs::rename(&tmp, &target).map_err(|e| format!("保存 {} 失败：{e}", target.display()))
}

/// 记下一次检查。查成了才改 `available`：没查成不等于没有新版本，上次查到的那条还作数。
pub fn record_check<E>(
    pref: &mut UpdatePreference,
    checked_at: String,
    outcome: &Result<Option<UpdateInfo>, E>,
) {
    pref.last_checked_at = Some(checked_at);
    if let Ok(offer) = outcome {
        pref.available = offer.clone();
    }
}

/// 一次能下载的版本。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub url: String,
}

/// 一次挑选的结果。
///
/// 「没有更新」和「判断不出来」必须分开：两者都返回 `None` 的话，仓库改名、
/// 接口变形、地址全都不合规——这些情况界面都会说「已经是最新版」，而且完全
/// 静默。这正是这个模块最不该说的谎。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Pick {
    /// 列表读懂了，里面没有比这更该提示的桌面版本。
    Nothing,
    /// 有一条能用的。
    Found(UpdateInfo),
    /// 有桌面版本，但没有一条能用（地址不是本仓库的 Release 页、字段缺失……）。
    /// 这是「没查成」，不是「已经最新」。
    Unusable,
}

/// 从 releases 列表里挑出最新的桌面版本。
///
/// 规则写死在这里而不是靠 GitHub 的 `latest`：那个接口给的是整个仓库的最新
/// release，很可能是插件的。草稿和预发布一律跳过。
pub fn latest_desktop_release(body: &Value) -> Pick {
    let mut best: Option<(Vec<u32>, UpdateInfo)> = None;
    // 「认得出的最高版本」和「能安全打开的最高版本」分开记。两者不一致，说明
    // 最新那一版我们打不开——那是「没查成」，不是「已经最新」。
    let mut highest_seen: Option<Vec<u32>> = None;
    let Some(items) = body.as_array() else {
        // 连列表都不是：这不是「没有更新」。
        return Pick::Unusable;
    };
    for item in items {
        if item["draft"].as_bool().unwrap_or(false) || item["prerelease"].as_bool().unwrap_or(false)
        {
            continue;
        }
        // 这里每一步都得 `continue` 而不是 `?`：用 `?` 的话，列表里任何一条
        // 缺字段的 release（接口加字段、异常发布、以后 API 变形）都会让整个函数
        // 返回 None，界面照直说「已经是最新版」——正好是这块代码最该避免的谎。
        let Some(tag) = item["tag_name"].as_str() else {
            continue;
        };
        let Some(version) = tag.strip_prefix(TAG_PREFIX) else {
            continue;
        };
        let Some(parts) = parse_version(version) else {
            continue;
        };
        match &highest_seen {
            Some(current) if *current >= parts => {}
            _ => highest_seen = Some(parts.clone()),
        }
        // 下载页地址在这里就得站得住：留到点「去下载页」才发现打不开，
        // 用户已经被告知「有新版本」了。
        let Some(url) = item["html_url"].as_str().filter(|url| is_release_page(url)) else {
            continue;
        };
        let candidate = UpdateInfo {
            version: version.to_string(),
            url: url.to_string(),
        };
        match &best {
            Some((current, _)) if *current >= parts => {}
            _ => best = Some((parts, candidate)),
        }
    }
    match (best, highest_seen) {
        // 最高版本正好是能打开的那一条。
        (Some((parts, info)), Some(highest)) if parts == highest => Pick::Found(info),
        // 认得出更高的版本，却只能打开一个更旧的。退回去说「有新版本 vN-1」，
        // 用户点完下载页装完，还是落后；说「已经最新」更是直接的谎。
        (_, Some(_)) => Pick::Unusable,
        (_, None) => Pick::Nothing,
    }
}

/// 只认本仓库 Release 页的地址。命令层打开前还会再查一次，这里是第一道。
///
/// 这个地址来自网络响应，最后会被交给系统浏览器打开，所以不能只比前缀：
/// `…/releases/../../../someone/else` 前缀是对的，浏览器规范化之后却落在
/// 别人的仓库。先解析成 URL，再一项项核对主机、端口、用户名密码和路径。
///
/// 解析会把 `..`、`.`、`%2e%2e`、反斜杠这些归一掉（实测过），但**编码过的
/// 分隔符不会**：`..%2f..%2f` 在 `Url` 眼里是一个普通路径段，前缀照样对得上，
/// 交给服务端才决定怎么解释。所以另外再拒一次 `%2e` / `%2f` / `%5c`——正常的
/// Release 地址里不会出现它们（文件名里的空格是 `%20`，不受影响）。
///
/// 以后要是接了镜像或代理域名，这里会一并拒掉——那时候该显式加白名单，
/// 而不是把判断放松。
/// 当前这个桌面版本对应的 GitHub Release 页。商店审核期间，插件 zip 就放在这一页。
pub fn desktop_release_tag_url(version: &str) -> String {
    format!(
        "https://github.com/TshyGO/resume-form-assistant-plugin/releases/tag/desktop-v{version}"
    )
}

pub fn is_release_page(url: &str) -> bool {
    let Ok(parsed) = Url::parse(url) else {
        return false;
    };
    let path = parsed.path();
    let lower = path.to_ascii_lowercase();
    parsed.scheme() == "https"
        && parsed.host_str() == Some("github.com")
        && parsed.port().is_none()
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && !lower.contains("%2e")
        && !lower.contains("%2f")
        && !lower.contains("%5c")
        && [
            "/TshyGO/resume-form-assistant-plugin/releases/",
            "/ptjworks/resume-form-assistant-plugin/releases/",
        ]
        .iter()
        .any(|prefix| path.strip_prefix(*prefix).is_some_and(is_release_page_tail))
}

/// Release 页在 `/releases/` 后面只有这三种形状。`/releases/new` 这类同源但
/// 不是发布页的路径没必要放进来——用户要去的是下载页。
fn is_release_page_tail(rest: &str) -> bool {
    rest == "latest"
        || rest.starts_with("tag/") && rest.len() > "tag/".len()
        || rest.starts_with("download/") && rest.len() > "download/".len()
}

fn parse_version(value: &str) -> Option<Vec<u32>> {
    let parts: Vec<&str> = value.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    parts.iter().map(|part| part.parse::<u32>().ok()).collect()
}

/// 发布列表从哪儿要。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Source {
    GitHub,
    /// 我们在 Cloudflare 上的中转，代查同一个 GitHub 地址。
    Relay,
}

/// 一页没要到的原因。
#[derive(Debug, Clone, PartialEq, Eq)]
enum PageError {
    /// 连不上、超时、正文读到一半断了。
    Unreachable,
    /// 403、429。
    RateLimited,
    /// 其他不成功的状态码。
    Status(u16),
    NotJson,
    NotList,
}

impl PageError {
    /// GitHub 这样失败时，同一页改问中转。只有 GitHub 明确答复了的 4xx（403、429 已归入
    /// 限流，408 是超时）不再问：中转代查的是同一个地址，答复也一样。
    fn worth_asking_relay(&self) -> bool {
        !matches!(self, PageError::Status(code) if (400..500).contains(code) && *code != 408)
    }

    fn into_command_error(self) -> CommandError {
        let (code, message) = match self {
            PageError::Unreachable => ("UPDATE_OFFLINE", "连不上更新服务器。".to_string()),
            PageError::RateLimited => ("UPDATE_RATE_LIMITED", "更新服务器暂时限流了。".to_string()),
            PageError::Status(status) => {
                ("UPDATE_FAILED", format!("更新服务器返回 HTTP {status}。"))
            }
            PageError::NotJson => ("UPDATE_FAILED", "更新服务器返回的不是 JSON。".to_string()),
            PageError::NotList => (
                "UPDATE_FAILED",
                "更新服务器返回的不是发布列表。".to_string(),
            ),
        };
        CommandError {
            code: code.into(),
            message,
        }
    }
}

/// 去问一次。失败一律是「没查成」，不是「已经最新」——这两件事不能混。
pub async fn fetch_latest() -> Result<Option<UpdateInfo>, CommandError> {
    fetch_latest_from(RELEASES_URL, RELAY_RELEASES_URL).await
}

async fn fetch_latest_from(github: &str, relay: &str) -> Result<Option<UpdateInfo>, CommandError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(TIMEOUT_SECONDS))
        .build()
        .map_err(|_| CommandError {
            code: "UPDATE_OFFLINE".into(),
            message: "查更新的客户端没建起来。".into(),
        })?;
    let client = &client;
    let releases = collect_releases(move |source, page| {
        let base = match source {
            Source::GitHub => github,
            Source::Relay => relay,
        };
        fetch_page(client, base, page)
    })
    .await?;
    // 中转给的列表和 GitHub 的走同一套挑选和地址校验。
    offer_from(&Value::Array(releases))
}

/// 一页一页地要发布列表，直到某一页不满。
///
/// 先问 GitHub。GitHub 哪一页没要到（见 [`PageError::worth_asking_relay`]），就丢掉已经
/// 拿到的页，从第 1 页起改问中转，后面的页也都问中转：GitHub 这时多半一直连不上，每页
/// 再等它超时一次只是白等；两边的列表也不完全一样（中转带口令去问，多出草稿的占位），
/// 拼在一起交界处会重复或漏掉几条。
///
/// 中转只代查前 10 页，要完第 10 页就停：列表从新到旧排，最新的 1000 条里早有最新的
/// 桌面版本了。
///
/// 两边都没要到时报 GitHub 的错，那是用户这边真实的情况。
async fn collect_releases<F, Fut>(mut fetch: F) -> Result<Vec<Value>, CommandError>
where
    F: FnMut(Source, u32) -> Fut,
    Fut: Future<Output = Result<Vec<Value>, PageError>>,
{
    let mut source = Source::GitHub;
    let mut page = 1_u32;
    let mut releases = Vec::new();
    loop {
        let items = match fetch(source, page).await {
            Ok(items) => items,
            Err(problem) if source == Source::GitHub && problem.worth_asking_relay() => {
                source = Source::Relay;
                releases.clear();
                page = 1;
                fetch(Source::Relay, page)
                    .await
                    .map_err(|_| problem.into_command_error())?
            }
            Err(problem) => return Err(problem.into_command_error()),
        };
        let item_count = items.len();
        releases.extend(items);
        if item_count < RELEASES_PER_PAGE || (source == Source::Relay && page >= RELAY_MAX_PAGE) {
            return Ok(releases);
        }
        page = page.checked_add(1).ok_or_else(|| CommandError {
            code: "UPDATE_FAILED".into(),
            message: "更新记录页数异常。".into(),
        })?;
    }
}

async fn fetch_page(
    client: &reqwest::Client,
    base: &str,
    page: u32,
) -> Result<Vec<Value>, PageError> {
    let response = client
        .get(format!("{base}?per_page={RELEASES_PER_PAGE}&page={page}"))
        // GitHub 要求带 User-Agent，不带会直接 403。
        .header("user-agent", "resume-pro-desktop")
        .header("accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|_| PageError::Unreachable)?;
    let status = response.status();
    if status.as_u16() == 403 || status.as_u16() == 429 {
        return Err(PageError::RateLimited);
    }
    if !status.is_success() {
        return Err(PageError::Status(status.as_u16()));
    }
    // 正文读到一半超时或断开，和连不上是一回事。
    let bytes = response.bytes().await.map_err(|_| PageError::Unreachable)?;
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(Value::Array(items)) => Ok(items),
        Ok(_) => Err(PageError::NotList),
        Err(_) => Err(PageError::NotJson),
    }
}

/// 挑选结果 → 命令层的返回。单独一个函数是为了这层映射也能被测到：
/// 「说不清」被当成「已经最新」是这块代码最贵的错法。
pub fn offer_from(body: &Value) -> Result<Option<UpdateInfo>, CommandError> {
    match latest_desktop_release(body) {
        Pick::Found(info) => Ok(Some(info)),
        Pick::Nothing => Ok(None),
        // 说不清的时候说「没查成」。说成「已经是最新版」，用户就再也不会去看了。
        // 走到这里有两种原因：返回的不是列表（接口变形、仓库改名），或者列表里
        // 每条的下载地址都不指向本仓库。对用户来说是同一句话：这次没查成。
        Pick::Unusable => Err(CommandError {
            code: "UPDATE_FAILED".into(),
            message: "读不懂更新服务器给的发布列表，这次没查成。".into(),
        }),
    }
}

/// 下载更新过程中的实时进度。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDownloadProgress {
    pub version: String,
    pub file_name: String,
    pub downloaded_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    /// `checksum` | `downloading` | `verifying` | `ready`
    pub phase: String,
}

/// 下载并完成 SHA-256 校验的安装包摘要（返回给前端，不含本机绝对路径）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedUpdate {
    pub version: String,
    pub file_name: String,
    pub sha256: String,
    pub size_bytes: u64,
}

/// 宿主内部持有的已校验安装包记录（含落盘路径，打开安装程序前再次复核磁盘文件 SHA-256）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedInstaller {
    pub info: DownloadedUpdate,
    pub path: PathBuf,
}

/// 当前平台在 GitHub Release 里对应的安装包文件名（与 `check-desktop-release.js` 的规则一致）。
pub fn installer_filename_for(version: &str, os: &str) -> Option<String> {
    parse_version(version)?;
    match os {
        "windows" => Some(format!("{INSTALLER_ASSET_PREFIX}_{version}_x64-setup.exe")),
        "macos" => Some(format!("{INSTALLER_ASSET_PREFIX}_{version}_aarch64.dmg")),
        _ => None,
    }
}

pub fn current_installer_filename(version: &str) -> Option<String> {
    installer_filename_for(version, std::env::consts::OS)
}

/// 从已校验过的 `UpdateInfo` 推导出本仓库对应版本的安装包下载地址与 `.sha256` 校验文件地址。
pub fn release_asset_urls(
    info: &UpdateInfo,
    installer_name: &str,
) -> Result<(String, String), CommandError> {
    if parse_version(&info.version).is_none() || !is_release_page(&info.url) {
        return Err(CommandError {
            code: "UPDATE_BAD_URL".into(),
            message: "更新版本或下载地址不合规，已拒绝下载。".into(),
        });
    }
    let parsed = Url::parse(&info.url).map_err(|_| CommandError {
        code: "UPDATE_BAD_URL".into(),
        message: "更新下载地址无效。".into(),
    })?;
    let path = parsed.path();
    let repo_prefix = [
        "/TshyGO/resume-form-assistant-plugin",
        "/ptjworks/resume-form-assistant-plugin",
    ]
    .into_iter()
    .find(|prefix| path.starts_with(&format!("{prefix}/releases/")))
    .ok_or_else(|| CommandError {
        code: "UPDATE_BAD_URL".into(),
        message: "更新下载地址不属于本仓库。".into(),
    })?;
    let installer_url = format!(
        "https://github.com{repo_prefix}/releases/download/{TAG_PREFIX}{}/{installer_name}",
        info.version
    );
    let checksum_url = format!("{installer_url}.sha256");
    if !is_release_page(&installer_url) || !is_release_page(&checksum_url) {
        return Err(CommandError {
            code: "UPDATE_BAD_URL".into(),
            message: "生成的安装包下载地址未通过安全校验。".into(),
        });
    }
    Ok((installer_url, checksum_url))
}

/// 解析 `.sha256` 文件内容（格式为 `<64位十六进制哈希>  <文件名>` 或 `<哈希> *<文件名>`）。
pub fn parse_checksum_file(text: &str, expected_filename: &str) -> Result<String, CommandError> {
    let bad = || CommandError {
        code: "UPDATE_BAD_CHECKSUM".into(),
        message: "更新服务器上的 SHA-256 校验文件格式异常，已停止下载。".into(),
    };
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.lines().count() != 1 {
        return Err(bad());
    }
    let fields: Vec<&str> = trimmed.split_whitespace().collect();
    if fields.len() != 2 {
        return Err(bad());
    }
    let digest = fields[0];
    let recorded_name = fields[1].strip_prefix('*').unwrap_or(fields[1]);
    if recorded_name != expected_filename
        || digest.len() != 64
        || !digest.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(bad());
    }
    Ok(digest.to_ascii_lowercase())
}

/// 计算本地普通文件的 SHA-256 与字节数（拒绝符号链接或目录）。
pub fn sha256_file(path: &Path) -> Result<(String, u64), std::io::Error> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "not a regular file",
        ));
    }
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    Ok((format!("{:x}", hasher.finalize()), total))
}

/// 下载安装包到 `<cache_dir>/updates/`，流式汇报进度并严格校验 SHA-256。
/// **绝不自动启动安装程序**；仅返回已校验通过的安装包信息，等待用户显式确认。
pub async fn download_installer<F>(
    cache_dir: &Path,
    info: &UpdateInfo,
    on_progress: F,
) -> Result<VerifiedInstaller, CommandError>
where
    F: FnMut(UpdateDownloadProgress),
{
    let installer_name = current_installer_filename(&info.version).ok_or_else(|| CommandError {
        code: "UPDATE_UNSUPPORTED_PLATFORM".into(),
        message: "当前系统暂不支持应用内直接下载安装包，请点「去下载页」手动下载。".into(),
    })?;
    let (installer_url, checksum_url) = release_asset_urls(info, &installer_name)?;
    download_installer_from(
        cache_dir,
        &info.version,
        &installer_name,
        &installer_url,
        &checksum_url,
        on_progress,
    )
    .await
}

fn ensure_not_symlink(path: &Path) -> Result<(), CommandError> {
    if let Ok(meta) = std::fs::symlink_metadata(path) {
        if meta.file_type().is_symlink() {
            return Err(CommandError {
                code: "UPDATE_WRITE_FAILED".into(),
                message: "更新缓存路径包含不安全的符号链接，已拒绝写入。".into(),
            });
        }
    }
    Ok(())
}

fn is_allowed_download_redirect(url: &Url) -> bool {
    match url.scheme() {
        "https" => matches!(
            url.host_str(),
            Some("github.com")
                | Some("objects.githubusercontent.com")
                | Some("release-assets.githubusercontent.com")
        ),
        #[cfg(test)]
        "http" => matches!(url.host_str(), Some("127.0.0.1") | Some("localhost")),
        _ => false,
    }
}

pub async fn download_installer_from<F>(
    cache_dir: &Path,
    version: &str,
    installer_name: &str,
    installer_url: &str,
    checksum_url: &str,
    mut on_progress: F,
) -> Result<VerifiedInstaller, CommandError>
where
    F: FnMut(UpdateDownloadProgress),
{
    let updates_dir = cache_dir.join(UPDATES_DIR_NAME);
    ensure_not_symlink(&updates_dir)?;
    std::fs::create_dir_all(&updates_dir).map_err(|e| CommandError {
        code: "UPDATE_WRITE_FAILED".into(),
        message: format!("创建更新缓存目录失败：{e}"),
    })?;
    ensure_not_symlink(&updates_dir)?;

    on_progress(UpdateDownloadProgress {
        version: version.to_string(),
        file_name: installer_name.to_string(),
        downloaded_bytes: 0,
        total_bytes: None,
        phase: "checksum".into(),
    });

    let redirect_policy = reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 {
            attempt.error("redirect limit exceeded")
        } else if is_allowed_download_redirect(attempt.url()) {
            attempt.follow()
        } else {
            attempt.error("disallowed redirect host or scheme")
        }
    });

    let client = reqwest::Client::builder()
        .redirect(redirect_policy)
        .connect_timeout(Duration::from_secs(TIMEOUT_SECONDS))
        .timeout(Duration::from_secs(DOWNLOAD_TIMEOUT_SECONDS))
        .build()
        .map_err(|_| CommandError {
            code: "UPDATE_OFFLINE".into(),
            message: "下载更新的客户端初始化失败。".into(),
        })?;

    let checksum_resp = client
        .get(checksum_url)
        .header("user-agent", "resume-pro-desktop")
        .send()
        .await
        .map_err(|_| CommandError {
            code: "UPDATE_OFFLINE".into(),
            message: "连不上更新服务器，无法获取 SHA-256 校验文件。".into(),
        })?;
    let checksum_status = checksum_resp.status();
    if checksum_status.as_u16() == 403 || checksum_status.as_u16() == 429 {
        return Err(CommandError {
            code: "UPDATE_RATE_LIMITED".into(),
            message: "更新服务器暂时限流了，请稍后再试或点「去下载页」手动下载。".into(),
        });
    }
    if !checksum_status.is_success() {
        return Err(CommandError {
            code: "UPDATE_FAILED".into(),
            message: format!(
                "获取 SHA-256 校验文件失败（HTTP {}）。",
                checksum_status.as_u16()
            ),
        });
    }
    let checksum_bytes = checksum_resp.bytes().await.map_err(|_| CommandError {
        code: "UPDATE_OFFLINE".into(),
        message: "读取 SHA-256 校验文件时连接中断。".into(),
    })?;
    if checksum_bytes.len() > MAX_CHECKSUM_BYTES {
        return Err(CommandError {
            code: "UPDATE_BAD_CHECKSUM".into(),
            message: "SHA-256 校验文件大小异常，已停止下载。".into(),
        });
    }
    let checksum_text = std::str::from_utf8(&checksum_bytes).map_err(|_| CommandError {
        code: "UPDATE_BAD_CHECKSUM".into(),
        message: "SHA-256 校验文件不是有效的文本。".into(),
    })?;
    let expected_sha256 = parse_checksum_file(checksum_text, installer_name)?;

    let final_path = updates_dir.join(installer_name);
    // 如果本地缓存里已经有同名安装包，且磁盘 SHA-256 与服务器 `.sha256` 完全一致，直接复用。
    if let Ok((existing_sha, existing_size)) = sha256_file(&final_path) {
        if existing_size > 0 && existing_sha == expected_sha256 {
            on_progress(UpdateDownloadProgress {
                version: version.to_string(),
                file_name: installer_name.to_string(),
                downloaded_bytes: existing_size,
                total_bytes: Some(existing_size),
                phase: "verifying".into(),
            });
            on_progress(UpdateDownloadProgress {
                version: version.to_string(),
                file_name: installer_name.to_string(),
                downloaded_bytes: existing_size,
                total_bytes: Some(existing_size),
                phase: "ready".into(),
            });
            return Ok(VerifiedInstaller {
                info: DownloadedUpdate {
                    version: version.to_string(),
                    file_name: installer_name.to_string(),
                    sha256: expected_sha256,
                    size_bytes: existing_size,
                },
                path: final_path,
            });
        }
    }

    let mut response = client
        .get(installer_url)
        .header("user-agent", "resume-pro-desktop")
        .send()
        .await
        .map_err(|_| CommandError {
            code: "UPDATE_OFFLINE".into(),
            message: "连不上更新服务器，安装包下载失败。".into(),
        })?;
    let status = response.status();
    if status.as_u16() == 403 || status.as_u16() == 429 {
        return Err(CommandError {
            code: "UPDATE_RATE_LIMITED".into(),
            message: "更新服务器暂时限流了，请稍后再试或点「去下载页」手动下载。".into(),
        });
    }
    if !status.is_success() {
        return Err(CommandError {
            code: "UPDATE_FAILED".into(),
            message: format!("下载安装包失败（HTTP {}）。", status.as_u16()),
        });
    }

    let total_bytes = response.content_length();
    if let Some(total) = total_bytes {
        if total == 0 || total > MAX_INSTALLER_BYTES {
            return Err(CommandError {
                code: "UPDATE_FAILED".into(),
                message: "安装包文件大小异常，已停止下载。".into(),
            });
        }
    }

    let part_path = updates_dir.join(format!("{installer_name}.part"));
    ensure_not_symlink(&part_path)?;
    ensure_not_symlink(&final_path)?;
    let _ = std::fs::remove_file(&part_path);
    let mut part_file = std::fs::File::create(&part_path).map_err(|e| CommandError {
        code: "UPDATE_WRITE_FAILED".into(),
        message: format!("创建临时安装包文件失败：{e}"),
    })?;

    on_progress(UpdateDownloadProgress {
        version: version.to_string(),
        file_name: installer_name.to_string(),
        downloaded_bytes: 0,
        total_bytes,
        phase: "downloading".into(),
    });

    let mut hasher = Sha256::new();
    let mut downloaded_bytes = 0u64;
    let mut last_reported_bytes = 0u64;

    loop {
        let next = response.chunk().await.map_err(|_| {
            let _ = std::fs::remove_file(&part_path);
            CommandError {
                code: "UPDATE_OFFLINE".into(),
                message: "安装包下载途中连接中断，请重试。".into(),
            }
        })?;
        let Some(chunk) = next else {
            break;
        };
        downloaded_bytes = downloaded_bytes.saturating_add(chunk.len() as u64);
        if downloaded_bytes > MAX_INSTALLER_BYTES {
            drop(part_file);
            let _ = std::fs::remove_file(&part_path);
            return Err(CommandError {
                code: "UPDATE_FAILED".into(),
                message: "安装包超出最大允许大小，已停止下载。".into(),
            });
        }
        if let Err(e) = part_file.write_all(&chunk) {
            drop(part_file);
            let _ = std::fs::remove_file(&part_path);
            return Err(CommandError {
                code: "UPDATE_WRITE_FAILED".into(),
                message: format!("写入安装包失败：{e}"),
            });
        }
        hasher.update(&chunk);
        if last_reported_bytes == 0
            || downloaded_bytes.saturating_sub(last_reported_bytes) >= PROGRESS_STEP_BYTES
            || Some(downloaded_bytes) == total_bytes
        {
            last_reported_bytes = downloaded_bytes;
            on_progress(UpdateDownloadProgress {
                version: version.to_string(),
                file_name: installer_name.to_string(),
                downloaded_bytes,
                total_bytes,
                phase: "downloading".into(),
            });
        }
    }

    if let Err(e) = part_file.flush().and_then(|_| part_file.sync_all()) {
        drop(part_file);
        let _ = std::fs::remove_file(&part_path);
        return Err(CommandError {
            code: "UPDATE_WRITE_FAILED".into(),
            message: format!("保存安装包到磁盘失败：{e}"),
        });
    }
    drop(part_file);

    if downloaded_bytes == 0
        || total_bytes.is_some_and(|expected_total| downloaded_bytes != expected_total)
    {
        let _ = std::fs::remove_file(&part_path);
        return Err(CommandError {
            code: "UPDATE_OFFLINE".into(),
            message: "安装包未完整下载，已清理临时文件，请重试。".into(),
        });
    }

    on_progress(UpdateDownloadProgress {
        version: version.to_string(),
        file_name: installer_name.to_string(),
        downloaded_bytes,
        total_bytes: Some(downloaded_bytes),
        phase: "verifying".into(),
    });

    let actual_sha256 = format!("{:x}", hasher.finalize());
    if actual_sha256 != expected_sha256 {
        let _ = std::fs::remove_file(&part_path);
        return Err(CommandError {
            code: "UPDATE_HASH_MISMATCH".into(),
            message: format!(
                "安装包 SHA-256 校验未通过（期望 {}…，实际 {}…），已删除损坏文件。",
                &expected_sha256[..12],
                &actual_sha256[..12]
            ),
        });
    }

    std::fs::rename(&part_path, &final_path).map_err(|e| {
        let _ = std::fs::remove_file(&part_path);
        CommandError {
            code: "UPDATE_WRITE_FAILED".into(),
            message: format!("保存已校验的安装包失败：{e}"),
        }
    })?;

    on_progress(UpdateDownloadProgress {
        version: version.to_string(),
        file_name: installer_name.to_string(),
        downloaded_bytes,
        total_bytes: Some(downloaded_bytes),
        phase: "ready".into(),
    });

    Ok(VerifiedInstaller {
        info: DownloadedUpdate {
            version: version.to_string(),
            file_name: installer_name.to_string(),
            sha256: expected_sha256,
            size_bytes: downloaded_bytes,
        },
        path: final_path,
    })
}

/// 用户点击「确认并打开安装程序」时，再次核对版本、哈希与磁盘上的安装包文件一致性。
pub fn verify_ready_installer(
    verified: &VerifiedInstaller,
    version: &str,
    sha256: &str,
) -> Result<PathBuf, CommandError> {
    if verified.info.version != version || !verified.info.sha256.eq_ignore_ascii_case(sha256) {
        return Err(CommandError {
            code: "UPDATE_NOT_DOWNLOADED".into(),
            message: "未找到对应版本的已校验安装包，请先下载更新。".into(),
        });
    }
    let (disk_sha, disk_size) = sha256_file(&verified.path).map_err(|_| CommandError {
        code: "UPDATE_NOT_DOWNLOADED".into(),
        message: "本地安装包不存在或无法读取，请重新下载。".into(),
    })?;
    if disk_size != verified.info.size_bytes || disk_sha != verified.info.sha256 {
        let _ = std::fs::remove_file(&verified.path);
        return Err(CommandError {
            code: "UPDATE_HASH_MISMATCH".into(),
            message: "本地安装包已被修改或损坏，SHA-256 校验未通过，请重新下载。".into(),
        });
    }
    Ok(verified.path.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 挑出来并且能用的那一条。挑不出来时直接让测试失败，信息比 `unwrap` 清楚。
    fn found(body: &Value) -> UpdateInfo {
        match latest_desktop_release(body) {
            Pick::Found(info) => info,
            other => panic!("没挑出可用的版本：{other:?}"),
        }
    }

    fn release(tag: &str, draft: bool, prerelease: bool) -> Value {
        json!({
            "tag_name": tag,
            "draft": draft,
            "prerelease": prerelease,
            "html_url": format!(
                "https://github.com/TshyGO/resume-form-assistant-plugin/releases/tag/{tag}"
            ),
        })
    }

    #[test]
    fn only_desktop_tags_count() {
        // 同一个仓库里还有插件的 release，别把它当成桌面的新版本。
        let body = json!([
            release("v0.5.0", false, false),
            release("desktop-v0.2.0", false, false)
        ]);
        assert_eq!(found(&body).version, "0.2.0");
    }

    #[test]
    fn the_newest_wins_regardless_of_order() {
        let body = json!([
            release("desktop-v0.2.0", false, false),
            release("desktop-v0.10.0", false, false),
            release("desktop-v0.9.0", false, false),
        ]);
        // 字符串比会说 0.9 更大。
        assert_eq!(found(&body).version, "0.10.0");
    }

    #[test]
    fn more_than_twenty_plugin_releases_do_not_hide_the_desktop_release() {
        let mut releases = (0..25)
            .map(|index| release(&format!("v0.5.{index}"), false, false))
            .collect::<Vec<_>>();
        releases.push(release("desktop-v0.2.0", false, false));
        assert_eq!(found(&Value::Array(releases)).version, "0.2.0");
    }

    #[test]
    fn drafts_and_prereleases_are_not_offered() {
        let body = json!([
            release("desktop-v0.3.0", true, false),
            release("desktop-v0.4.0", false, true),
            release("desktop-v0.1.0", false, false),
        ]);
        assert_eq!(found(&body).version, "0.1.0");
    }

    #[test]
    fn a_beta_tag_is_never_offered_even_if_it_was_not_flagged_as_prerelease() {
        // 测试版发成预发布，上面那条已经把它挡在外面；这里锁住第二道：
        // 哪天有人漏勾了「预发布」，带 -beta 的版本号也解析不出来，仍然会被跳过。
        // 正式版用户不该被推到测试版。
        let body = json!([
            release("desktop-v0.2.0-beta.1", false, false),
            release("desktop-v0.1.0", false, false),
        ]);
        assert_eq!(found(&body).version, "0.1.0");
    }

    #[test]
    fn one_malformed_entry_does_not_hide_the_rest() {
        // 缺字段的 release 只该被跳过。整列作废的后果是界面说「已经是最新版」——
        // 用户永远不知道有新版本，而这正是最难被发现的那种错。
        let body = json!([
            json!({ "draft": false, "prerelease": false }),
            json!({ "tag_name": 42 }),
            release("desktop-v1.0.0", false, false),
        ]);
        assert_eq!(found(&body).version, "1.0.0");
    }

    #[test]
    fn a_release_without_a_usable_download_page_is_skipped() {
        // 说了「有新版」就得能点开。地址不对的条目在筛选阶段就该出局，
        // 而不是等用户点「去下载页」才报错。
        let mut broken = release("desktop-v1.0.0", false, false);
        broken["html_url"] = json!("https://example.test/not-a-release");
        let body = json!([release("desktop-v2.0.0", false, false), broken]);
        assert_eq!(found(&body).version, "2.0.0");

        // 一条桌面版本都用不上时，那是「没查成」，不是「已经最新」。
        let mut missing = release("desktop-v3.0.0", false, false);
        missing["html_url"] = Value::Null;
        assert_eq!(latest_desktop_release(&json!([missing])), Pick::Unusable);
    }

    #[test]
    fn a_broken_newest_release_is_not_covered_up_by_an_older_working_one() {
        // 最高版本打不开、次高版本能打开时，不能退回去报次高版本：本机要是已经
        // 装着次高版本，退回去的结果就是界面说「已经是最新版」——最新那一版
        // 出了问题，反而一个字都没提。
        let mut broken = release("desktop-v2.0.0", false, false);
        broken["html_url"] = json!("https://example.test/not-a-release");
        let body = json!([broken, release("desktop-v1.0.0", false, false)]);
        assert_eq!(latest_desktop_release(&body), Pick::Unusable);
    }

    #[test]
    fn a_list_we_cannot_read_is_not_the_same_as_being_up_to_date() {
        // 仓库改名、接口变形、地址全都不合规——这些都不是「已经是最新版」。
        assert_eq!(
            latest_desktop_release(&json!({"message": "Not Found"})),
            Pick::Unusable
        );
        assert_eq!(latest_desktop_release(&json!("字符串")), Pick::Unusable);
        // 真的没有桌面版本，才是「没有更新」。
        assert_eq!(latest_desktop_release(&json!([])), Pick::Nothing);
        assert_eq!(
            latest_desktop_release(&json!([release("v1.0.0", false, false)])),
            Pick::Nothing
        );
    }

    #[test]
    fn only_this_repository_release_pages_are_accepted() {
        assert!(is_release_page(
            "https://github.com/TshyGO/resume-form-assistant-plugin/releases/tag/desktop-v0.1.0"
        ));
        // 别人仓库的 Release 页、明文 http、以及别的路径都不行。
        assert!(!is_release_page(
            "https://github.com/someone/else/releases/tag/v1"
        ));
        assert!(!is_release_page(
            "http://github.com/TshyGO/resume-form-assistant-plugin/releases/tag/desktop-v0.1.0"
        ));
        assert!(!is_release_page(
            "https://github.com/TshyGO/resume-form-assistant-plugin"
        ));
        // 前缀对、规范化之后却在别人仓库的那几种写法。
        assert!(!is_release_page(
            "https://github.com/TshyGO/resume-form-assistant-plugin/releases/../../someone/else"
        ));
        assert!(!is_release_page(
            "https://github.com/TshyGO/resume-form-assistant-plugin/releases/%2e%2e/%2e%2e/someone/else"
        ));
        // 编码过的分隔符：`Url` 不会把它当成路径分隔符，前缀照样对得上。
        assert!(!is_release_page(
            "https://github.com/TshyGO/resume-form-assistant-plugin/releases/..%2f..%2fsomeone/else"
        ));
        assert!(!is_release_page(
            "https://github.com/TshyGO/resume-form-assistant-plugin/releases/..%5c..%5csomeone/else"
        ));
        // 文件名里的空格是 `%20`，不该被上面那条连坐。
        assert!(is_release_page(
            "https://github.com/TshyGO/resume-form-assistant-plugin/releases/download/desktop-v0.1.0/Resume%20Pro%20Desktop_0.1.0_x64-setup.exe"
        ));
        // 同一个仓库、同样在 `/releases/` 下面，但不是发布页。
        assert!(!is_release_page(
            "https://github.com/TshyGO/resume-form-assistant-plugin/releases/new"
        ));
        assert!(!is_release_page(
            "https://github.com/TshyGO/resume-form-assistant-plugin/releases/tag/"
        ));
        // 主机像是 github.com，其实不是。
        assert!(!is_release_page(
            "https://github.com.evil.test/TshyGO/resume-form-assistant-plugin/releases/tag/desktop-v0.1.0"
        ));
        assert!(!is_release_page(
            "https://user:pass@github.com/TshyGO/resume-form-assistant-plugin/releases/tag/desktop-v0.1.0"
        ));
        assert!(!is_release_page(
            "https://github.com:8443/TshyGO/resume-form-assistant-plugin/releases/tag/desktop-v0.1.0"
        ));
        // `/releases` 本身不是一个下载页，别把用户扔到一个空路径上。
        assert!(!is_release_page(
            "https://github.com/TshyGO/resume-form-assistant-plugin/releases/"
        ));
        assert!(!is_release_page("不是地址"));
        // Release 页的另外两种形状也要认。
        assert!(is_release_page(
            "https://github.com/TshyGO/resume-form-assistant-plugin/releases/download/desktop-v0.1.0/setup.exe"
        ));
        assert!(is_release_page(
            "https://github.com/TshyGO/resume-form-assistant-plugin/releases/latest"
        ));
        assert!(is_release_page(&desktop_release_tag_url("0.4.0-beta.3")));
        assert!(is_release_page(&desktop_release_tag_url("0.4.0")));
    }

    #[test]
    fn ownership_transition_accepts_both_owners_without_relaxing_url_guards() {
        assert_eq!(RELEASES_URL, "https://api.github.com/repositories/1217054301/releases");
        for owner in ["TshyGO", "ptjworks"] {
            let base = format!("https://github.com/{owner}/resume-form-assistant-plugin");
            for tail in ["latest", "tag/desktop-v0.4.5", "download/desktop-v0.4.5/setup.exe"] {
                assert!(is_release_page(&format!("{base}/releases/{tail}")));
            }
            for tail in ["", "new", "tag/", "../../someone/else", "..%2f..%2fother", "..%5c..%5cother", "%2e%2e/%2e%2e/other"] {
                assert!(!is_release_page(&format!("{base}/releases/{tail}")));
            }
            for bad in [
                format!("http://github.com/{owner}/resume-form-assistant-plugin/releases/latest"),
                format!("https://github.com.evil.test/{owner}/resume-form-assistant-plugin/releases/latest"),
                format!("https://user:pass@github.com/{owner}/resume-form-assistant-plugin/releases/latest"),
                format!("https://github.com:8443/{owner}/resume-form-assistant-plugin/releases/latest"),
                format!("{base}-other/releases/latest"),
            ] {
                assert!(!is_release_page(&bad));
            }
        }
        let mut migrated = release("desktop-v0.4.5", false, false);
        migrated["html_url"] = json!("https://github.com/ptjworks/resume-form-assistant-plugin/releases/tag/desktop-v0.4.5");
        assert_eq!(found(&json!([release("desktop-v0.4.4", false, false), migrated])).version, "0.4.5");
        assert!(!is_release_page("https://github.com/ptjworks-other/resume-form-assistant-plugin/releases/latest"));
    }

    #[test]
    fn saying_nothing_and_saying_i_cannot_tell_map_to_different_answers() {
        // 「没有更新」是 Ok(None)，「读不懂」必须是错误。两者混在一起，用户就
        // 会在一个坏掉的检查上看到「已经是最新版」。
        assert_eq!(offer_from(&json!([])).unwrap(), None);
        let found = offer_from(&json!([release("desktop-v9.9.9", false, false)]))
            .unwrap()
            .unwrap();
        assert_eq!(found.version, "9.9.9");

        let mut bad_url = release("desktop-v1.0.0", false, false);
        bad_url["html_url"] = json!("https://github.com/someone/else/releases/tag/v1");
        let err = offer_from(&json!([bad_url])).unwrap_err();
        assert_eq!(err.code, "UPDATE_FAILED");
    }

    #[test]
    fn a_tag_we_cannot_parse_is_skipped_without_panicking() {
        // 形状不对的 tag 既不是更新，也不该让整次检查炸掉。
        assert_eq!(
            latest_desktop_release(&json!([release("desktop-v不是版本号", false, false)])),
            Pick::Nothing
        );
    }

    #[test]
    fn the_preference_round_trips_and_a_broken_file_falls_back() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path()), UpdatePreference::default());

        let pref = UpdatePreference {
            enabled: false,
            last_checked_at: Some("2026-09-17T10:00:00Z".into()),
            available: Some(UpdateInfo {
                version: "0.5.0".into(),
                url: desktop_release_tag_url("0.5.0"),
            }),
        };
        save(dir.path(), &pref).unwrap();
        assert_eq!(load(dir.path()), pref);

        std::fs::write(path_for(dir.path()), "{ 坏掉的").unwrap();
        assert_eq!(load(dir.path()), UpdatePreference::default());
    }

    #[test]
    fn an_older_preference_file_still_loads() {
        // 升级前写的文件只有这两项，读出来不能退回默认（那会把用户关掉的开关又打开）。
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            path_for(dir.path()),
            r#"{"enabled":false,"lastCheckedAt":"2026-09-17T10:00:00Z"}"#,
        )
        .unwrap();
        let pref = load(dir.path());
        assert!(!pref.enabled);
        assert_eq!(pref.available, None);
    }

    #[test]
    fn a_file_that_remembered_a_dismissed_version_still_loads() {
        // 有一段开发版把「关掉的版本」写进了文件。现在不认这一项：读得出来，
        // 开关和查到的版本都还在，下次写盘时这一项自然消失。
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            path_for(dir.path()),
            r#"{"enabled":true,"available":{"version":"0.5.0","url":"https://github.com/ptjworks/resume-form-assistant-plugin/releases/tag/desktop-v0.5.0"},"dismissedVersion":"0.5.0"}"#,
        )
        .unwrap();
        let pref = load(dir.path());
        assert!(pref.enabled);
        assert_eq!(pref.available.map(|info| info.version).as_deref(), Some("0.5.0"));
        save(dir.path(), &load(dir.path())).unwrap();
        let text = std::fs::read_to_string(path_for(dir.path())).unwrap();
        assert!(!text.contains("dismissedVersion"), "{text}");
    }

    fn offer(version: &str) -> UpdateInfo {
        UpdateInfo {
            version: version.into(),
            url: desktop_release_tag_url(version),
        }
    }

    #[test]
    fn a_found_update_is_kept_for_the_notice_and_cleared_when_there_is_none() {
        let mut pref = UpdatePreference::default();
        record_check::<()>(&mut pref, "t1".into(), &Ok(Some(offer("0.5.0"))));
        assert_eq!(pref.available, Some(offer("0.5.0")));
        assert_eq!(pref.last_checked_at.as_deref(), Some("t1"));

        // 查成了、没有更新（比如已经装上了新版）：旧的那条不能留着继续提示。
        record_check::<()>(&mut pref, "t2".into(), &Ok(None));
        assert_eq!(pref.available, None);
    }

    #[test]
    fn a_failed_check_records_the_attempt_but_does_not_invent_or_drop_an_offer() {
        let mut pref = UpdatePreference::default();
        record_check(&mut pref, "t1".into(), &Err("offline"));
        assert_eq!(pref.available, None, "没查成不能凭空冒出一条提示");
        assert_eq!(pref.last_checked_at.as_deref(), Some("t1"));

        pref.available = Some(offer("0.5.0"));
        record_check(&mut pref, "t2".into(), &Err("offline"));
        assert_eq!(pref.available, Some(offer("0.5.0")), "上次查到的那条还作数");
    }

    // ---- GitHub 查不到时改问中转 ----

    /// 一页 `count` 条插件版本，最后放一条桌面版本（`count` 为 0 时就是空页）。
    fn page_of(count: usize, desktop: &str) -> Vec<Value> {
        let mut items: Vec<Value> = (1..count)
            .map(|index| release(&format!("v0.0.{index}"), false, false))
            .collect();
        if count > 0 {
            items.push(release(&format!("desktop-v{desktop}"), false, false));
        }
        items
    }

    /// 按 `answer` 应答，记下每次问的是谁、第几页。
    async fn run(
        answer: impl Fn(Source, u32) -> Result<Vec<Value>, PageError>,
    ) -> (Result<Vec<Value>, CommandError>, Vec<(Source, u32)>) {
        let mut asked = Vec::new();
        let result = collect_releases(|source, page| {
            asked.push((source, page));
            std::future::ready(answer(source, page))
        })
        .await;
        (result, asked)
    }

    #[tokio::test]
    async fn the_relay_is_not_asked_while_github_answers() {
        let (result, asked) = run(|source, page| match (source, page) {
            (Source::GitHub, 1) => Ok(page_of(RELEASES_PER_PAGE, "0.1.0")),
            (Source::GitHub, 2) => Ok(page_of(3, "0.2.0")),
            other => panic!("不该问 {other:?}"),
        })
        .await;
        assert_eq!(result.unwrap().len(), RELEASES_PER_PAGE + 3);
        assert_eq!(asked, [(Source::GitHub, 1), (Source::GitHub, 2)]);
    }

    #[tokio::test]
    async fn a_page_github_cannot_give_is_asked_again_from_the_relay() {
        // 连不上、超时（包括 408）、5xx、限流，以及 GitHub 给的东西读不懂，都改问中转。
        for problem in [
            PageError::Unreachable,
            PageError::RateLimited,
            PageError::Status(408),
            PageError::Status(500),
            PageError::Status(503),
            PageError::NotJson,
            PageError::NotList,
        ] {
            let (result, asked) = run(|source, _| match source {
                Source::GitHub => Err(problem.clone()),
                Source::Relay => Ok(page_of(2, "0.3.0")),
            })
            .await;
            let releases = result.unwrap_or_else(|err| panic!("{problem:?}：{}", err.message));
            assert_eq!(found(&Value::Array(releases)).version, "0.3.0");
            assert_eq!(
                asked,
                [(Source::GitHub, 1), (Source::Relay, 1)],
                "{problem:?}"
            );
        }
    }

    #[tokio::test]
    async fn once_github_fails_the_whole_list_comes_from_the_relay() {
        // GitHub 第 2 页没要到：丢掉 GitHub 的第 1 页，从第 1 页起全问中转，不把两边拼在一起。
        let (result, asked) = run(|source, page| match (source, page) {
            (Source::GitHub, 1) => Ok(page_of(RELEASES_PER_PAGE, "0.1.0")),
            (Source::GitHub, 2) => Err(PageError::Unreachable),
            (Source::Relay, 1) => Ok(page_of(RELEASES_PER_PAGE, "0.4.0")),
            (Source::Relay, 2) => Ok(page_of(RELEASES_PER_PAGE, "0.2.0")),
            (Source::Relay, 3) => Ok(page_of(1, "0.3.0")),
            other => panic!("不该问 {other:?}"),
        })
        .await;
        let releases = result.unwrap();
        assert_eq!(releases.len(), 2 * RELEASES_PER_PAGE + 1);
        assert_eq!(found(&Value::Array(releases.clone())).version, "0.4.0");
        // GitHub 第 1 页里的桌面版本没有留下来。
        assert!(!releases
            .iter()
            .any(|item| item["tag_name"] == "desktop-v0.1.0"));
        assert_eq!(
            asked,
            [
                (Source::GitHub, 1),
                (Source::GitHub, 2),
                (Source::Relay, 1),
                (Source::Relay, 2),
                (Source::Relay, 3)
            ]
        );
    }

    #[tokio::test]
    async fn the_relay_is_not_asked_past_its_last_page() {
        // 中转只代查前 10 页，第 11 页会被它拒掉；到第 10 页就停，用已经拿到的 1000 条。
        let (result, asked) = run(|source, page| match source {
            Source::GitHub if page == 1 => Err(PageError::Unreachable),
            Source::Relay if page <= RELAY_MAX_PAGE => {
                Ok(page_of(RELEASES_PER_PAGE, &format!("0.{page}.0")))
            }
            other => panic!("不该问 {other:?} 第 {page} 页"),
        })
        .await;
        let releases = result.unwrap();
        assert_eq!(releases.len(), RELAY_MAX_PAGE as usize * RELEASES_PER_PAGE);
        assert_eq!(found(&Value::Array(releases)).version, "0.10.0");
        assert_eq!(asked.len(), 1 + RELAY_MAX_PAGE as usize);
        assert_eq!(asked.last(), Some(&(Source::Relay, RELAY_MAX_PAGE)));

        // GitHub 在第 10 页之后才出错：同样从第 1 页起问中转，问到第 10 页停。
        let (result, asked) = run(|source, page| match (source, page) {
            (Source::GitHub, 11) => Err(PageError::Status(502)),
            (Source::GitHub, _) => Ok(page_of(RELEASES_PER_PAGE, "0.1.0")),
            (Source::Relay, page) if page <= RELAY_MAX_PAGE => {
                Ok(page_of(RELEASES_PER_PAGE, "0.2.0"))
            }
            other => panic!("不该问 {other:?}"),
        })
        .await;
        assert_eq!(result.unwrap().len(), 10 * RELEASES_PER_PAGE);
        assert_eq!(asked.len(), 11 + RELAY_MAX_PAGE as usize);
        assert_eq!(asked.last(), Some(&(Source::Relay, RELAY_MAX_PAGE)));
    }

    #[test]
    fn the_page_rules_match_what_the_relay_accepts() {
        // 中转只认 per_page=100、第 1～10 页，两边的常量改一处就要改另一处。
        // 从 Cargo.toml 所在目录算起：这份文件被复制到别处编译（发布版回放）时路径也对。
        let relay = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../services/feedback-relay/src/releases.mjs"
        ));
        assert!(
            relay.contains(&format!(
                "export const RELEASES_PER_PAGE = {RELEASES_PER_PAGE};"
            )),
            "中转的每页条数和桌面不一致"
        );
        assert!(
            relay.contains(&format!(
                "export const RELEASES_MAX_PAGE = {RELAY_MAX_PAGE};"
            )),
            "中转的最大页数和桌面不一致"
        );
        assert!(
            relay.contains(&format!("'{RELEASES_URL}'")),
            "中转代查的不是同一个地址"
        );
    }

    #[tokio::test]
    async fn a_definite_answer_from_github_is_not_asked_again() {
        // 404 这类答复，中转代查同一个地址也只会是同样的结果。
        for status in [400, 401, 404, 410, 422] {
            let (result, asked) = run(|source, _| match source {
                Source::GitHub => Err(PageError::Status(status)),
                Source::Relay => panic!("不该问中转"),
            })
            .await;
            let err = result.unwrap_err();
            assert_eq!(err.code, "UPDATE_FAILED");
            assert!(err.message.contains(&status.to_string()), "{}", err.message);
            assert_eq!(asked, [(Source::GitHub, 1)]);
        }
    }

    #[tokio::test]
    async fn when_both_fail_the_github_failure_is_what_the_user_sees() {
        for (github, relay, code) in [
            (
                PageError::RateLimited,
                PageError::Unreachable,
                "UPDATE_RATE_LIMITED",
            ),
            (
                PageError::Unreachable,
                PageError::Status(502),
                "UPDATE_OFFLINE",
            ),
            (PageError::Status(500), PageError::NotList, "UPDATE_FAILED"),
        ] {
            let (result, asked) = run(|source, _| match source {
                Source::GitHub => Err(github.clone()),
                Source::Relay => Err(relay.clone()),
            })
            .await;
            assert_eq!(result.unwrap_err().code, code, "{github:?} / {relay:?}");
            assert_eq!(asked, [(Source::GitHub, 1), (Source::Relay, 1)]);
        }
        // 已经改问中转之后，中转这一页再出错，就报中转的错。
        let (result, _) = run(|source, page| match (source, page) {
            (Source::GitHub, 1) => Err(PageError::Unreachable),
            (Source::Relay, 1) => Ok(page_of(RELEASES_PER_PAGE, "0.1.0")),
            (Source::Relay, 2) => Err(PageError::Status(503)),
            other => panic!("不该问 {other:?}"),
        })
        .await;
        let err = result.unwrap_err();
        assert_eq!(err.code, "UPDATE_FAILED");
        assert!(err.message.contains("503"), "{}", err.message);
    }

    /// 只应答一次的本地 HTTP 服务。返回地址（`http://127.0.0.1:端口`）和收到的请求头。
    fn serve_once(status: u16, body: &'static str) -> (String, std::sync::mpsc::Receiver<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut raw = Vec::new();
            let mut chunk = [0; 4096];
            while !String::from_utf8_lossy(&raw).contains("\r\n\r\n") {
                let n = socket.read(&mut chunk).unwrap_or(0);
                if n == 0 {
                    break;
                }
                raw.extend_from_slice(&chunk[..n]);
            }
            tx.send(String::from_utf8_lossy(&raw).to_string()).ok();
            let response = format!(
                "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes());
        });
        (address, rx)
    }

    /// 一个没人监听的地址：连上去会被拒绝。
    fn closed_address() -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://{}", listener.local_addr().unwrap())
    }

    const RELAY_LIST: &str = r#"[{"tag_name":null,"draft":true,"prerelease":false,"html_url":null},{"tag_name":"v0.6.0","draft":false,"prerelease":false,"html_url":"https://github.com/ptjworks/resume-form-assistant-plugin/releases/tag/v0.6.0"},{"tag_name":"desktop-v0.5.1","draft":false,"prerelease":false,"html_url":"https://github.com/ptjworks/resume-form-assistant-plugin/releases/tag/desktop-v0.5.1"}]"#;

    #[tokio::test]
    async fn github_errors_over_http_fall_back_to_the_relay() {
        assert_eq!(RELAY_RELEASES_URL, "https://feedback.19991107.xyz/releases");
        for (status, body) in [
            (503, "busy"),
            (502, ""),
            (403, r#"{"message":"API rate limit exceeded"}"#),
            (429, ""),
            (200, "<html>不是 JSON</html>"),
        ] {
            let (github, github_seen) = serve_once(status, body);
            let (relay, relay_seen) = serve_once(200, RELAY_LIST);
            let offer = fetch_latest_from(
                &format!("{github}/repositories/1217054301/releases"),
                &format!("{relay}/releases"),
            )
            .await
            .unwrap_or_else(|err| panic!("HTTP {status}：{}", err.message))
            .unwrap();
            assert_eq!(offer.version, "0.5.1");
            assert_eq!(
                offer.url,
                "https://github.com/ptjworks/resume-form-assistant-plugin/releases/tag/desktop-v0.5.1"
            );
            let github_request = github_seen.recv().unwrap();
            assert!(
                github_request.starts_with(
                    "GET /repositories/1217054301/releases?per_page=100&page=1 HTTP/1.1"
                ),
                "{github_request}"
            );
            let relay_request = relay_seen.recv().unwrap();
            assert!(
                relay_request.starts_with("GET /releases?per_page=100&page=1 HTTP/1.1"),
                "{relay_request}"
            );
            assert!(relay_request
                .to_lowercase()
                .contains("user-agent: resume-pro-desktop"));
        }
    }

    #[tokio::test]
    async fn an_unreachable_github_falls_back_to_the_relay() {
        let (relay, relay_seen) = serve_once(200, RELAY_LIST);
        let offer = fetch_latest_from(&closed_address(), &format!("{relay}/releases"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(offer.version, "0.5.1");
        assert!(relay_seen
            .recv()
            .unwrap()
            .starts_with("GET /releases?per_page=100&page=1 "));
    }

    #[tokio::test]
    async fn what_the_relay_returns_goes_through_the_same_checks() {
        // 中转给的地址不是本仓库的 Release 页：照样是「没查成」，不是「有新版本」。
        let (github, _) = serve_once(503, "");
        let (relay, _) = serve_once(
            200,
            r#"[{"tag_name":"desktop-v9.0.0","draft":false,"prerelease":false,"html_url":"https://example.test/setup.exe"}]"#,
        );
        let err = fetch_latest_from(&github, &relay).await.unwrap_err();
        assert_eq!(err.code, "UPDATE_FAILED");

        // 中转的草稿占位和预发布照样跳过；什么都没有就是「没有更新」。
        let (github, _) = serve_once(500, "");
        let (relay, _) = serve_once(
            200,
            r#"[{"tag_name":null,"draft":true,"prerelease":false,"html_url":null},{"tag_name":"desktop-v9.0.0","draft":false,"prerelease":true,"html_url":"https://github.com/ptjworks/resume-form-assistant-plugin/releases/tag/desktop-v9.0.0"}]"#,
        );
        assert_eq!(fetch_latest_from(&github, &relay).await.unwrap(), None);

        // 两边都不行时报 GitHub 的错。
        let (github, _) = serve_once(429, "");
        let (relay, _) = serve_once(502, r#"{"ok":false,"error":"github_unreachable"}"#);
        assert_eq!(
            fetch_latest_from(&github, &relay).await.unwrap_err().code,
            "UPDATE_RATE_LIMITED"
        );
        let err = fetch_latest_from(&closed_address(), &closed_address())
            .await
            .unwrap_err();
        assert_eq!(err.code, "UPDATE_OFFLINE");
    }

    #[tokio::test]
    async fn a_github_answer_over_http_is_used_as_is() {
        let (github, _) = serve_once(200, RELAY_LIST);
        let offer = fetch_latest_from(&github, &closed_address())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(offer.version, "0.5.1");
        // GitHub 说找不到：不改问中转。
        let (github, _) = serve_once(404, r#"{"message":"Not Found"}"#);
        let (relay, relay_seen) = serve_once(200, RELAY_LIST);
        let err = fetch_latest_from(&github, &relay).await.unwrap_err();
        assert_eq!(err.code, "UPDATE_FAILED");
        assert!(err.message.contains("404"), "{}", err.message);
        assert!(relay_seen.try_recv().is_err(), "不该问中转");
    }

    #[test]
    fn installer_filename_and_asset_urls_match_release_workflow_conventions() {
        assert_eq!(
            installer_filename_for("0.5.1", "windows").as_deref(),
            Some("wangshen-kuaitian_0.5.1_x64-setup.exe")
        );
        assert_eq!(
            installer_filename_for("0.5.1", "macos").as_deref(),
            Some("wangshen-kuaitian_0.5.1_aarch64.dmg")
        );
        assert_eq!(installer_filename_for("0.5.1-beta.1", "windows"), None);
        assert_eq!(installer_filename_for("../0.5.1", "windows"), None);
        assert_eq!(installer_filename_for("0.5.1", "linux"), None);

        for owner in ["ptjworks", "TshyGO"] {
            let info = UpdateInfo {
                version: "0.5.1".into(),
                url: format!(
                    "https://github.com/{owner}/resume-form-assistant-plugin/releases/tag/desktop-v0.5.1"
                ),
            };
            let (installer_url, checksum_url) =
                release_asset_urls(&info, "wangshen-kuaitian_0.5.1_x64-setup.exe").unwrap();
            assert_eq!(
                installer_url,
                format!("https://github.com/{owner}/resume-form-assistant-plugin/releases/download/desktop-v0.5.1/wangshen-kuaitian_0.5.1_x64-setup.exe")
            );
            assert_eq!(checksum_url, format!("{installer_url}.sha256"));
        }

        let bad = UpdateInfo {
            version: "0.5.1".into(),
            url: "https://github.com/someone/else/releases/tag/desktop-v0.5.1".into(),
        };
        assert_eq!(
            release_asset_urls(&bad, "wangshen-kuaitian_0.5.1_x64-setup.exe")
                .unwrap_err()
                .code,
            "UPDATE_BAD_URL"
        );
    }

    #[test]
    fn checksum_parser_accepts_standard_and_binary_shasum_lines_and_rejects_tampering() {
        let name = "wangshen-kuaitian_0.5.1_x64-setup.exe";
        let digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        assert_eq!(
            parse_checksum_file(&format!("{digest}  {name}\n"), name).unwrap(),
            digest
        );
        assert_eq!(
            parse_checksum_file(&format!("{} *{name}\r\n", digest.to_uppercase()), name).unwrap(),
            digest
        );
        for invalid in [
            "".to_string(),
            format!("{digest}"),
            format!("{digest}  other.exe"),
            format!("short  {name}"),
            format!("{digest}  {name} extra"),
            format!("{digest}  {name}\n{digest}  {name}"),
        ] {
            assert_eq!(
                parse_checksum_file(&invalid, name).unwrap_err().code,
                "UPDATE_BAD_CHECKSUM",
                "{invalid}"
            );
        }
    }

    #[tokio::test]
    async fn downloading_installer_streams_progress_verifies_sha256_and_reuses_verified_cache() {
        let dir = tempfile::tempdir().unwrap();
        let name = "wangshen-kuaitian_0.5.2_x64-setup.exe";
        let payload = "synthetic-installer-binary-payload-0.5.2";
        let expected_sha = format!("{:x}", Sha256::digest(payload.as_bytes()));
        let checksum_line = format!("{expected_sha}  {name}\n");

        let (checksum_srv, _) = serve_once(200, Box::leak(checksum_line.clone().into_boxed_str()));
        let (installer_srv, _) = serve_once(200, payload);

        let mut progress = Vec::new();
        let verified = download_installer_from(
            dir.path(),
            "0.5.2",
            name,
            &format!("{installer_srv}/{name}"),
            &format!("{checksum_srv}/{name}.sha256"),
            |p| progress.push(p),
        )
        .await
        .unwrap();

        assert_eq!(verified.info.version, "0.5.2");
        assert_eq!(verified.info.file_name, name);
        assert_eq!(verified.info.sha256, expected_sha);
        assert_eq!(verified.info.size_bytes, payload.len() as u64);
        assert!(verified.path.is_file());
        assert_eq!(
            progress.first().map(|p| p.phase.as_str()),
            Some("checksum")
        );
        assert!(progress.iter().any(|p| p.phase == "downloading"));
        assert!(progress.iter().any(|p| p.phase == "verifying"));
        assert_eq!(progress.last().map(|p| p.phase.as_str()), Some("ready"));

        // 已经下载并校验通过的同名文件再次点下载时，校验 `.sha256` 后直接复用本地缓存，不重下安装包。
        let (checksum_srv2, _) = serve_once(200, Box::leak(checksum_line.into_boxed_str()));
        let mut reused_progress = Vec::new();
        let reused = download_installer_from(
            dir.path(),
            "0.5.2",
            name,
            &closed_address(),
            &format!("{checksum_srv2}/{name}.sha256"),
            |p| reused_progress.push(p),
        )
        .await
        .unwrap();
        assert_eq!(reused, verified);
        assert!(!reused_progress.iter().any(|p| p.phase == "downloading"));

        // 打开安装程序前再次复核磁盘文件 SHA-256。
        let ready_path =
            verify_ready_installer(&verified, "0.5.2", &expected_sha).unwrap();
        assert_eq!(ready_path, verified.path);

        // 若磁盘上的安装包在确认前被篡改，拒绝打开并清理被改过的文件。
        std::fs::write(&verified.path, "tampered-after-download").unwrap();
        let err = verify_ready_installer(&verified, "0.5.2", &expected_sha).unwrap_err();
        assert_eq!(err.code, "UPDATE_HASH_MISMATCH");
        assert!(!verified.path.exists());
    }

    #[tokio::test]
    async fn mismatched_sha256_deletes_partial_file_and_returns_hash_mismatch_error() {
        let dir = tempfile::tempdir().unwrap();
        let name = "wangshen-kuaitian_0.5.2_x64-setup.exe";
        let wrong_sha = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
        let checksum_line = format!("{wrong_sha}  {name}\n");

        let (checksum_srv, _) = serve_once(200, Box::leak(checksum_line.into_boxed_str()));
        let (installer_srv, _) = serve_once(200, "corrupted-or-tampered-bytes");

        let err = download_installer_from(
            dir.path(),
            "0.5.2",
            name,
            &format!("{installer_srv}/{name}"),
            &format!("{checksum_srv}/{name}.sha256"),
            |_| {},
        )
        .await
        .unwrap_err();

        assert_eq!(err.code, "UPDATE_HASH_MISMATCH");
        let updates_dir = dir.path().join("updates");
        assert!(!updates_dir.join(name).exists());
        assert!(!updates_dir.join(format!("{name}.part")).exists());
    }
}
