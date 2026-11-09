//! 「有没有新版本」这一件事。**只查、只说，不下载、不安装。**
//!
//! 为什么不做静默更新：安装包没有签名。让程序自己下一个未签名的安装包再运行，
//! 比让用户自己去下载页点一下糟得多——那等于把「确认这是我要的东西」这一步
//! 从用户手里拿走了。
//!
//! 查的是 GitHub 的 releases 列表，只认 `desktop-v*` 的 tag：插件用的是
//! `v*.*.*`，两边混在同一个仓库里。GitHub 在国内时好时坏，连不上、超时、
//! 5xx 或限流时，同一页改问我们在 Cloudflare 上的中转（`services/feedback-relay`
//! 的 `/releases`，代查同一个 GitHub 地址），挑版本和校验地址的规则都不变。

use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

use crate::commands::CommandError;

const RELEASES_URL: &str =
    "https://api.github.com/repositories/1217054301/releases";
/// GitHub 查不到时的备用来源。返回和 GitHub 同样形状的列表，每条只留挑版本用到的四个字段。
const RELAY_RELEASES_URL: &str = "https://feedback.19991107.xyz/releases";
const RELEASES_PER_PAGE: usize = 100;
const TAG_PREFIX: &str = "desktop-v";
const TIMEOUT_SECONDS: u64 = 10;
const FILE_NAME: &str = "update-check.json";

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
/// 先问 GitHub。GitHub 这一页没要到（见 [`PageError::worth_asking_relay`]），就改问中转，
/// 后面的页也都问中转：GitHub 这时多半一直连不上，每页再等它超时一次只是白等。
/// 前后两段来自不同来源时，交界处可能重复或漏掉几条：中转带口令去问，列表里多出
/// 草稿的占位；中转的页最多缓存 10 分钟，这期间新发的版本会让后面的页错开。列表从新
/// 到旧排，交界在第 100 条前后，影响不到最新的桌面版本（现在一共几十条，只有一页）。
/// 中转只代查前 10 页。
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
                fetch(Source::Relay, page)
                    .await
                    .map_err(|_| problem.into_command_error())?
            }
            Err(problem) => return Err(problem.into_command_error()),
        };
        let item_count = items.len();
        releases.extend(items);
        if item_count < RELEASES_PER_PAGE {
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
    async fn once_github_fails_the_remaining_pages_come_from_the_relay() {
        let (result, asked) = run(|source, page| match (source, page) {
            (Source::GitHub, 1) => Ok(page_of(RELEASES_PER_PAGE, "0.1.0")),
            (Source::GitHub, 2) => Err(PageError::Unreachable),
            (Source::Relay, 2) => Ok(page_of(RELEASES_PER_PAGE, "0.2.0")),
            (Source::Relay, 3) => Ok(page_of(1, "0.3.0")),
            other => panic!("不该问 {other:?}"),
        })
        .await;
        assert_eq!(result.unwrap().len(), 2 * RELEASES_PER_PAGE + 1);
        assert_eq!(
            asked,
            [
                (Source::GitHub, 1),
                (Source::GitHub, 2),
                (Source::Relay, 2),
                (Source::Relay, 3)
            ]
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
}
