use archive_store::*;

fn config(root: &std::path::Path) -> ArchiveConfig {
    ArchiveConfig::new(root.join("archive"), root.join("current.json"))
}

fn open(root: &std::path::Path) -> ArchiveStore {
    ArchiveStore::open(config(root)).unwrap()
}

fn input(question: &str, answer: &str, previous: Option<&str>) -> SiteAnswerInput {
    SiteAnswerInput { question: question.into(), answer: answer.into(), previous: previous.map(str::to_string) }
}

#[test]
fn the_store_judges_questions_and_answers_like_the_plugin() {
    // 插件 tests/site-answers.test.js 用同一份对照。
    let vectors: serde_json::Value = serde_json::from_str(include_str!("site_answer_vectors.json")).unwrap();
    for pair in vectors["keys"].as_array().unwrap() {
        assert_eq!(question_key(pair[0].as_str().unwrap()), pair[1].as_str().unwrap(), "{pair}");
    }
    for (kind, expected) in [("accepted", true), ("rejected", false)] {
        for title in vectors["titles"][kind].as_array().unwrap() {
            assert_eq!(site_question_allowed(title.as_str().unwrap()), expected, "{title}");
        }
    }
    for (kind, expected) in [("identifiers", true), ("plain", false)] {
        for answer in vectors["answers"][kind].as_array().unwrap() {
            assert_eq!(looks_like_identifier(answer.as_str().unwrap()), expected, "{answer}");
        }
    }
    // 插件认为和桌面旧回答相同的，桌面核对 previous 时也相同；插件认为不同的，桌面也报冲突。
    let dir = tempfile::tempdir().unwrap();
    let db = open(dir.path());
    for (kind, same) in [("sameAnswers", true), ("differentAnswers", false)] {
        for (i, pair) in vectors[kind].as_array().unwrap().iter().enumerate() {
            let site = format!("{kind}-{i}.example.com").to_lowercase();
            db.save_site_answers(&site, &[input("是否有亲属在本公司工作", pair[0].as_str().unwrap(), None)]).unwrap();
            let seen = input("是否有亲属在本公司工作", "改过的回答", pair[1].as_str());
            match db.save_site_answers(&site, &[seen]) {
                Ok(_) => assert!(same, "{pair}"),
                Err(err) => assert!(!same && err.code() == "conflict", "{pair}: {}", err.code()),
            }
        }
    }
}

#[test]
fn only_questions_about_the_company_with_short_plain_answers_are_kept() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(dir.path());
    // 插件挑候选时已经筛过；这里是存储层自己再拦一次，回归了也不会把普通资料、号码存进这张表。
    for bad in [input("兴趣爱好", "摄影", None), input("亲属在本公司工作的联系电话", "见附件", None),
        input("是否有亲属在本公司工作", "父亲 13800138000", None), input("是否有亲属在本公司工作", "见 https://example.com", None)] {
        assert_eq!(db.save_site_answers("campus.example.com", &[bad]).unwrap_err().code(), "validation_failed");
    }
    assert!(db.all_site_answers().unwrap().is_empty());
    db.save_site_answers("campus.example.com", &[input("是否有亲属在本公司工作", "父亲在本公司财务部任职", None)]).unwrap();
}

fn pairs(answers: &[SiteAnswer]) -> Vec<(&str, &str)> {
    answers.iter().map(|a| (a.question.as_str(), a.answer.as_str())).collect()
}

#[test]
fn answers_are_kept_per_site_and_read_back_in_the_order_saved() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(dir.path());
    assert!(db.site_answers("campus.example.com").unwrap().is_empty());
    db.save_site_answers("campus.example.com", &[input("是否有亲属在本公司工作", "否", None)]).unwrap();
    let saved = db.save_site_answers("campus.example.com", &[input("是否曾在本行实习", "是", None)]).unwrap();
    assert_eq!(pairs(&saved), vec![("是否有亲属在本公司工作", "否"), ("是否曾在本行实习", "是")]);
    db.save_site_answers("app.mokahr.com/other", &[input("是否有亲属在本公司工作", "是", None)]).unwrap();
    assert_eq!(pairs(&db.site_answers("app.mokahr.com/other").unwrap()), vec![("是否有亲属在本公司工作", "是")]);
    assert_eq!(db.all_site_answers().unwrap().len(), 3);
    assert_eq!(db.all_site_answers().unwrap()[0].site, "app.mokahr.com/other");
}

#[test]
fn the_same_question_written_differently_replaces_one_row_only_when_the_seen_answer_matches() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(dir.path());
    db.save_site_answers("campus.example.com", &[input("是否有亲属在本公司工作", "否", None)]).unwrap();
    // 没看到桌面里已有回答就当它没有：不覆盖。
    let err = db.save_site_answers("campus.example.com", &[input("*是否有亲属在本公司工作：", "是", None)]).unwrap_err();
    assert_eq!(err.code(), "conflict");
    let err = db.save_site_answers("campus.example.com", &[input("是否有亲属在本公司工作", "是", Some("别的"))]).unwrap_err();
    assert_eq!(err.code(), "conflict");
    let saved = db
        .save_site_answers("campus.example.com", &[input("*是否有亲属在本公司工作：", "是", Some("否"))])
        .unwrap();
    assert_eq!(pairs(&saved), vec![("*是否有亲属在本公司工作：", "是")]);
    // 桌面里删掉了，再拿旧回答当 previous 来存也是冲突。
    assert_eq!(db.delete_site_answer("campus.example.com", "是否有亲属在本公司工作").unwrap(), 1);
    let err = db.save_site_answers("campus.example.com", &[input("是否有亲属在本公司工作", "否", Some("是"))]).unwrap_err();
    assert_eq!(err.code(), "conflict");
}

#[test]
fn a_rejected_batch_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(dir.path());
    db.save_site_answers("campus.example.com", &[input("是否曾在本行实习", "否", None)]).unwrap();
    let batch = [input("是否有亲属在本公司工作", "否", None), input("是否曾在本行实习", "是", None)];
    assert_eq!(db.save_site_answers("campus.example.com", &batch).unwrap_err().code(), "conflict");
    assert_eq!(pairs(&db.site_answers("campus.example.com").unwrap()), vec![("是否曾在本行实习", "否")]);
    for bad in [
        input("本公司内网密码", "不知道", None),
        input("是否有亲属在本公司工作", "验证码：123456", None),
        input("是否有亲属在本公司工作", &"很".repeat(MAX_SITE_ANSWER_CHARS + 1), None),
        input(&"题".repeat(MAX_SITE_QUESTION_CHARS + 1), "否", None),
        input("  ", "否", None),
        input("是否有亲属在本公司工作", "否\u{1}", None),
    ] {
        assert_eq!(db.save_site_answers("campus.example.com", &[bad]).unwrap_err().code(), "validation_failed");
    }
    let twice = [input("是否有亲属在本公司工作", "否", None), input("是否有亲属在本公司工作：", "是", None)];
    assert_eq!(db.save_site_answers("campus.example.com", &twice).unwrap_err().code(), "validation_failed");
    assert_eq!(db.site_answers("campus.example.com").unwrap().len(), 1);
}

#[test]
fn one_site_holds_at_most_thirty_questions() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(dir.path());
    let full: Vec<SiteAnswerInput> =
        (0..MAX_SITE_ANSWERS_PER_SITE).map(|i| input(&format!("本公司问题{i}"), "否", None)).collect();
    db.save_site_answers("campus.example.com", &full).unwrap();
    let err = db.save_site_answers("campus.example.com", &[input("本公司问题多一道", "否", None)]).unwrap_err();
    assert_eq!(err.code(), "validation_failed");
    assert_eq!(db.site_answers("campus.example.com").unwrap().len(), MAX_SITE_ANSWERS_PER_SITE);
    // 改已有的题不算多一道。
    db.save_site_answers("campus.example.com", &[input("本公司问题0", "是", Some("否"))]).unwrap();
}

#[test]
fn deleting_a_site_leaves_the_other_sites() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(dir.path());
    db.save_site_answers("a.example.com", &[input("是否有亲属在本公司工作", "否", None), input("是否曾在本行实习", "否", None)])
        .unwrap();
    db.save_site_answers("b.example.com", &[input("是否有亲属在本公司工作", "是", None)]).unwrap();
    assert_eq!(db.delete_site("a.example.com").unwrap(), 2);
    assert_eq!(db.delete_site("a.example.com").unwrap(), 0);
    assert_eq!(pairs(&db.all_site_answers().unwrap()), vec![("是否有亲属在本公司工作", "是")]);
}

#[test]
fn a_v7_archive_gains_the_table_and_keeps_its_profile() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let old = ArchiveStore::open_with_migrations(cfg.clone(), &migration::MIGRATIONS[..7]).unwrap();
    let mut profile = empty_profile();
    profile["custom"] = serde_json::json!([{"key": "是否服从调剂", "value": "是"}]);
    old.save_profile(profile.clone(), 0).unwrap();
    old.close().unwrap();
    let upgraded = ArchiveStore::open(cfg).unwrap();
    assert_eq!(upgraded.schema_version(), 8);
    assert!(upgraded.migration_backup.as_ref().is_some_and(|path| path.is_file()));
    assert_eq!(upgraded.get_profile().unwrap().profile, profile);
    upgraded.save_site_answers("campus.example.com", &[input("是否有亲属在本公司工作", "否", None)]).unwrap();
}
