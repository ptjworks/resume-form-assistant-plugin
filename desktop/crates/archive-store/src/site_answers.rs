//! 按网站记住的回答（#429 第五项第 2 点）。
//!
//! 「我的信息」的补充字段换个网站也照填；题目问到对方公司的（「是否有亲属在本公司工作」），
//! 换一家答案可能不同，只在同一个网站复用。插件在用户确认后经 `siteAnswers.save` 写进来，
//! 下次在同一个网站经 `siteAnswers.read` 读回去，题目归一后全等才填。
//!
//! 网站（`site`）由插件按网址算：小写 host，几家公司共用一个 host 的招聘平台再加一段公司路径；
//! 格式由协议层的 `is_site_key` 检查。同一网站里题目按 [question_key] 归一后只存一条。

use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use crate::error::StoreError;
use crate::resume_secrets::{is_secret_label, is_secret_value};
use crate::timeutil::now_utc;
use crate::tx::StoreTx;

/// 一个网站最多存的题数。和协议 `siteAnswers.read` 响应的 `maxItems` 一致：
/// 题目 120 字、回答 300 字，按四字节一个字算 30 条也装得进一条 64 KiB 的信封。
pub const MAX_SITE_ANSWERS_PER_SITE: usize = 30;
/// 全部网站加起来的上限，满了要先在桌面删掉一些。
pub const MAX_SITE_ANSWERS: usize = 3000;
/// 与插件 `profile-fields.js` 的 `MAX_OFFERED_LABEL_CHARS` 一致。
pub const MAX_SITE_QUESTION_CHARS: usize = 120;
/// 与插件 `profile-fields.js` 的 `JOB_SPECIFIC_VALUE_CHARS` 一致：更长的多半是整段作答，不复用。
pub const MAX_SITE_ANSWER_CHARS: usize = 300;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteAnswer {
    pub site: String,
    pub question: String,
    pub answer: String,
    pub updated_at: String,
}

/// 一条要存的回答。`previous` 是用户确认时看到的桌面旧回答，`None` 表示当时桌面里没有这道题。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiteAnswerInput {
    pub question: String,
    pub answer: String,
    pub previous: Option<String>,
}

/// 题目归一：与插件 `profile-fields.js` 的 `normalizeKey` 同一口径（小写，去掉空白、冒号、星号、括号、
/// 短横、下划线、斜杠、点），改这里要同步改那边。
pub fn question_key(question: &str) -> String {
    const DROPPED: &str = ":：*（）()【】[]-_/.·";
    question
        .trim()
        .to_lowercase()
        .chars()
        .filter(|c| !c.is_whitespace() && !DROPPED.contains(*c))
        .collect()
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::Validation(message.into())
}

fn clean(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

impl StoreTx<'_> {
    /// 一个网站存的回答，按第一次存的先后。
    pub fn site_answers(&self, site: &str) -> Result<Vec<SiteAnswer>, StoreError> {
        let mut stmt = self.conn().prepare(
            "SELECT site, question, answer, updated_at FROM site_answers WHERE site = ?1 ORDER BY created_at, rowid",
        )?;
        let rows = stmt.query_map(params![site], |r| {
            Ok(SiteAnswer { site: r.get(0)?, question: r.get(1)?, answer: r.get(2)?, updated_at: r.get(3)? })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// 桌面「网站回答」列表用：全部网站，按网站名、再按存的先后。
    pub fn all_site_answers(&self) -> Result<Vec<SiteAnswer>, StoreError> {
        let mut stmt = self.conn().prepare(
            "SELECT site, question, answer, updated_at FROM site_answers ORDER BY site, created_at, rowid",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(SiteAnswer { site: r.get(0)?, question: r.get(1)?, answer: r.get(2)?, updated_at: r.get(3)? })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// 存一批回答，返回这个网站存完后的全部回答。整批一起成功或一起不写：
    /// 有一条的 `previous` 和桌面现在的对不上（别处刚改过、删过），返回 `Conflict`；
    /// 像密码、验证码的，超长的，放不下的，返回 `Validation`。
    pub fn save_site_answers(&mut self, site: &str, inputs: &[SiteAnswerInput]) -> Result<Vec<SiteAnswer>, StoreError> {
        if inputs.is_empty() {
            return Err(invalid("没有要保存的回答。"));
        }
        let now = now_utc();
        let mut seen = std::collections::HashSet::new();
        for input in inputs {
            let question = clean(&input.question);
            let answer = clean(&input.answer);
            let key = question_key(&question);
            if key.is_empty() || answer.is_empty() {
                return Err(invalid("题目和回答都不能是空的。"));
            }
            if question.chars().count() > MAX_SITE_QUESTION_CHARS || answer.chars().count() > MAX_SITE_ANSWER_CHARS {
                return Err(invalid("题目或回答太长，没有保存。"));
            }
            // 控制字符在 JSON 里要转义成六个字节，30 条满长的回答会撑破一条 64 KiB 的读取响应；表单里也不该有。
            if question.chars().chain(answer.chars()).any(char::is_control) {
                return Err(invalid("题目或回答里有看不见的控制字符，没有保存。"));
            }
            if is_secret_label(&question) || is_secret_value(&answer) {
                return Err(invalid(format!("「{question}」看起来是密码或验证码，这类内容不存进档案（档案会随备份带走）。")));
            }
            if !seen.insert(key.clone()) {
                return Err(invalid(format!("「{question}」在这次保存里出现了两次。")));
            }
            let current: Option<String> = self
                .conn()
                .query_row(
                    "SELECT answer FROM site_answers WHERE site = ?1 AND question_key = ?2",
                    params![site, key],
                    |r| r.get(0),
                )
                .optional()?;
            if current.as_deref().map(clean) != input.previous.as_deref().map(clean) {
                return Err(StoreError::Conflict(format!("「{question}」在桌面里刚有了不同的回答，请重新核对后再保存。")));
            }
            self.conn().execute(
                "INSERT INTO site_answers (site, question_key, question, answer, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5) \
                 ON CONFLICT(site, question_key) DO UPDATE SET question = excluded.question, \
                 answer = excluded.answer, updated_at = excluded.updated_at",
                params![site, key, question, answer, now],
            )?;
        }
        let per_site: i64 =
            self.conn().query_row("SELECT COUNT(*) FROM site_answers WHERE site = ?1", params![site], |r| r.get(0))?;
        if per_site as usize > MAX_SITE_ANSWERS_PER_SITE {
            return Err(invalid(format!("一个网站最多记住 {MAX_SITE_ANSWERS_PER_SITE} 道题，先在桌面删掉用不上的。")));
        }
        let total: i64 = self.conn().query_row("SELECT COUNT(*) FROM site_answers", [], |r| r.get(0))?;
        if total as usize > MAX_SITE_ANSWERS {
            return Err(invalid(format!("网站回答最多存 {MAX_SITE_ANSWERS} 条，先在桌面删掉用不上的。")));
        }
        self.site_answers(site)
    }

    /// 删一道题；`question` 按 [question_key] 归一后比。返回删掉的条数。
    pub fn delete_site_answer(&mut self, site: &str, question: &str) -> Result<usize, StoreError> {
        Ok(self.conn().execute(
            "DELETE FROM site_answers WHERE site = ?1 AND question_key = ?2",
            params![site, question_key(question)],
        )?)
    }

    /// 删掉一个网站的全部回答。返回删掉的条数。
    pub fn delete_site(&mut self, site: &str) -> Result<usize, StoreError> {
        Ok(self.conn().execute("DELETE FROM site_answers WHERE site = ?1", params![site])?)
    }
}

#[cfg(test)]
mod tests {
    use super::question_key;

    #[test]
    fn question_keys_drop_the_same_marks_as_the_plugin() {
        assert_eq!(question_key(" *是否有亲属在本公司工作： "), "是否有亲属在本公司工作");
        assert_eq!(question_key("是否（曾）在本行 实习"), "是否曾在本行实习");
        assert_eq!(question_key("CET-6 成绩"), "cet6成绩");
    }
}
