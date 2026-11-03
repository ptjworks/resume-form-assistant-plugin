use archive_store::*;

fn config(root: &std::path::Path) -> ArchiveConfig {
    ArchiveConfig::new(root.join("archive"), root.join("current.json"))
}

fn open(root: &std::path::Path) -> ArchiveStore {
    ArchiveStore::open(config(root)).unwrap()
}

// 只有文件头像样的最小样本：按内容认类型，不看扩展名。
fn pdf(filler: usize) -> Vec<u8> {
    let mut bytes = b"%PDF-1.7\n".to_vec();
    bytes.extend((0..filler).map(|i| (i % 251) as u8));
    bytes
}

fn png() -> Vec<u8> {
    [&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A][..], b"\0\0\0\rIHDR rest"].concat()
}

fn jpeg() -> Vec<u8> {
    [&[0xFF, 0xD8, 0xFF, 0xE0][..], b"\0\x10JFIF rest"].concat()
}

/// OLE 复合文档：文件头之后，按 128 字节对齐的目录项里放一个名字叫 `name`、类型是 `kind` 的条目。
fn ole(name: &str, kind: u8, at: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; 1024];
    bytes[..8].copy_from_slice(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
    let encoded: Vec<u8> = format!("{name}\0").encode_utf16().flat_map(u16::to_le_bytes).collect();
    bytes[at..at + encoded.len()].copy_from_slice(&encoded);
    bytes[at + 64] = encoded.len() as u8;
    bytes[at + 66] = kind;
    bytes
}

fn doc() -> Vec<u8> {
    ole("WordDocument", 2, 640)
}

/// 不压缩的最小 ZIP：本地文件头、中央目录、目录结尾。CRC 不填，识别时不看。
fn zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    zip_with_comment(entries, b"")
}

fn zip_with_comment(entries: &[(&str, &[u8])], comment: &[u8]) -> Vec<u8> {
    let le16 = |n: usize| (n as u16).to_le_bytes();
    let le32 = |n: usize| (n as u32).to_le_bytes();
    let (mut out, mut central) = (Vec::new(), Vec::new());
    for (name, body) in entries {
        let offset = out.len();
        out.extend(b"PK\x03\x04");
        out.extend([20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        out.extend(le32(0));
        out.extend(le32(body.len()));
        out.extend(le32(body.len()));
        out.extend(le16(name.len()));
        out.extend(le16(0));
        out.extend(name.as_bytes());
        out.extend(*body);
        central.extend(b"PK\x01\x02");
        central.extend([20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        central.extend(le32(0));
        central.extend(le32(body.len()));
        central.extend(le32(body.len()));
        central.extend(le16(name.len()));
        central.extend([0u8; 12]);
        central.extend(le32(offset));
        central.extend(name.as_bytes());
    }
    let start = out.len();
    out.extend(&central);
    out.extend(b"PK\x05\x06");
    out.extend([0u8; 4]);
    out.extend(le16(entries.len()));
    out.extend(le16(entries.len()));
    out.extend(le32(central.len()));
    out.extend(le32(start));
    out.extend(le16(comment.len()));
    out.extend(comment);
    out
}

fn docx() -> Vec<u8> {
    zip(&[("[Content_Types].xml", b"<Types/>"), ("_rels/.rels", b"<Relationships/>"), ("word/document.xml", b"<w:document/>")])
}

fn code(error: StoreError) -> &'static str {
    error.code()
}

/// 删掉了，也清干净了：没有卡在 tmp/ 里的，没有会挡住备份的残留，核对也没出错。
fn clean(result: &ResumeFileDeletion) -> bool {
    result.deleted
        && result.stuck_in_tmp.is_none()
        && result.folder.leftovers.is_empty()
        && result.folder.manual.is_empty()
        && result.folder.unchecked.is_none()
}

#[test]
fn files_are_taken_by_their_content_and_kind_not_by_their_name() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(dir.path());
    let resume = db.add_resume_file(ResumeFileKind::Resume, "C:\\Users\\a\\测试用户_简历.pdf", &pdf(10)).unwrap();
    assert_eq!((resume.name.as_str(), resume.mime.as_str()), ("测试用户_简历.pdf", "application/pdf"));
    assert_eq!(db.add_resume_file(ResumeFileKind::Resume, "简历.doc", &doc()).unwrap().mime, "application/msword");
    assert_eq!(
        db.add_resume_file(ResumeFileKind::Resume, "简历", &docx()).unwrap().name,
        "简历.docx",
        "a name without an extension gets the one its content has"
    );
    assert_eq!(db.add_resume_file(ResumeFileKind::Photo, "证件照.JPG", &jpeg()).unwrap().name, "证件照.jpg");
    assert_eq!(db.add_resume_file(ResumeFileKind::Transcript, "成绩单.png", &png()).unwrap().mime, "image/png");

    let refused = [
        (ResumeFileKind::Photo, "证件照.pdf", pdf(11)),       // 证件照只收图片
        (ResumeFileKind::Resume, "简历.png", [png(), b"x".to_vec()].concat()), // 简历只收文档
        (ResumeFileKind::Resume, "简历.docx", pdf(12)),       // 内容是 PDF，扩展名却是 docx
        // XLSX，表格里的文字恰好是「word/document.xml」：只看 ZIP 目录里的条目名，不看内容。
        (ResumeFileKind::Other, "表格.docx", zip(&[("[Content_Types].xml", b"<Types/>"), ("xl/workbook.xml", b"<workbook/>"),
            ("xl/sharedStrings.xml", b"<t>word/document.xml</t>")])),
        // 带宏的 Word 改了扩展名。
        (ResumeFileKind::Other, "宏.docx", zip(&[("[Content_Types].xml", b"<Types/>"), ("word/document.xml", b"<w:document/>"),
            ("word/vbaProject.bin", b"macro")])),
        // 只有本地文件头、没有目录的残缺 ZIP。
        (ResumeFileKind::Other, "残缺.docx", [&b"PK\x03\x04"[..], b"[Content_Types].xml word/document.xml"].concat()),
        (ResumeFileKind::Other, "表格.doc", ole("Workbook", 2, 640)),           // XLS
        (ResumeFileKind::Other, "存储.doc", ole("WordDocument", 1, 640)),       // 同名，但不是流
        (ResumeFileKind::Other, "文字.doc", ole("WordDocument", 2, 600)),       // 不在目录项的位置上
        (ResumeFileKind::Other, "说明.pdf", "只是文字".as_bytes().to_vec()),
        (ResumeFileKind::Other, "空.pdf", Vec::new()),
        (ResumeFileKind::Resume, "大.pdf", pdf(MAX_RESUME_FILE_BYTES)),
    ];
    for (kind, name, bytes) in refused {
        assert_eq!(code(db.add_resume_file(kind, name, &bytes).unwrap_err()), "validation_failed", "{name}");
    }
    assert_eq!(db.resume_files().unwrap().len(), 5, "nothing refused was kept");
    // ZIP 注释里也带着目录结尾的签名：只认注释正好延伸到文件末尾的那一条，合法的 DOCX 照收。
    let commented = zip_with_comment(
        &[("[Content_Types].xml", b"<Types/>"), ("word/document.xml", b"<w:document/>")],
        b"note PK\x05\x06 0123456789012345678 end",
    );
    assert_eq!(db.add_resume_file(ResumeFileKind::Resume, "带注释.docx", &commented).unwrap().mime, sniff_resume_file(&docx()).unwrap());
}

#[test]
fn a_damaged_record_is_listed_apart_never_guessed_and_the_rest_still_work() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let db = open(dir.path());
    let fields = vec![TemplateField { key: "姓名".into(), value: "测试用户".into() }];
    let template = db.create_template("校招", vec![TemplateGroup { name: "基本信息".into(), fields }]).unwrap().template;
    let file = db.add_resume_file(ResumeFileKind::Resume, "简历.pdf", &pdf(1)).unwrap();
    db.update_resume_file(&file.id, &ResumeFilePatch { template_ids: Some(vec![template.id.clone()]), ..Default::default() }).unwrap();
    db.close().unwrap();
    for (i, damage) in [
        "UPDATE resume_files SET template_ids_json = 'not json'",
        "UPDATE resume_files SET template_ids_json = '{\"all\": true}'",
        // 协议里的模板 id 是带连字符的 UUID：别的写法、超过上限的个数都按读不出算，不让整个列表发不出去。
        "UPDATE resume_files SET template_ids_json = '[\"not-a-template\"]'",
        "UPDATE resume_files SET template_ids_json = '[\"77777777777747778777777777777701\"]'",
        "PRAGMA ignore_check_constraints = ON; UPDATE resume_files SET kind = 'cover'",
    ]
    .into_iter()
    .enumerate()
    {
        let raw = rusqlite::Connection::open(cfg.db_path()).unwrap();
        raw.execute_batch(&format!("{damage} WHERE id = '{}'; PRAGMA ignore_check_constraints = OFF;", file.id)).unwrap();
        drop(raw);
        let db = open(dir.path());
        // 不当成「所有模板」「其他材料」：不在能用的文件里，单独列出来；单个读也报错。别的文件照常。
        let listing = db.resume_file_listing().unwrap();
        assert!(listing.files.iter().all(|f| f.id != file.id), "{damage}");
        assert_eq!(listing.files.len(), i, "{damage}");
        assert_eq!(listing.damaged.iter().map(|d| (d.id.as_str(), d.name.as_str())).collect::<Vec<_>>(), vec![(file.id.as_str(), "简历.pdf")]);
        assert!(db.resume_files().unwrap().iter().all(|f| f.id != file.id));
        assert_eq!(code(db.resume_file(&file.id).unwrap_err()), "internal_error", "{damage}");
        assert_eq!(code(db.read_resume_file_chunk(&file.id, &file.sha256, 0).unwrap_err()), "internal_error", "{damage}");
        // 有一条读不出来，清理照样做完，只是不动这条记录的字节。
        std::fs::write(dir.path().join("archive").join(RESUME_FILES_DIR).join("leftover"), b"x").unwrap();
        db.add_resume_file(ResumeFileKind::Photo, &format!("照片{i}.png"), &[png(), vec![i as u8]].concat()).unwrap();
        assert!(!dir.path().join("archive").join(RESUME_FILES_DIR).join("leftover").exists(), "{damage}");
        assert!(dir.path().join("archive").join(RESUME_FILES_DIR).join(&file.sha256).is_file(), "{damage}");
        db.close().unwrap();
        let raw = rusqlite::Connection::open(cfg.db_path()).unwrap();
        raw.execute_batch(&format!(
            "PRAGMA ignore_check_constraints = ON; UPDATE resume_files SET kind = 'resume', template_ids_json = '[\"{}\"]' WHERE id = '{}';",
            template.id, file.id
        ))
        .unwrap();
    }
    // 读不出来的记录可以删，和能用的记录走同一条路：按哈希放的字节一起删掉，别的文件不动。
    let raw = rusqlite::Connection::open(cfg.db_path()).unwrap();
    raw.execute_batch(&format!("UPDATE resume_files SET template_ids_json = 'not json' WHERE id = '{}'", file.id)).unwrap();
    drop(raw);
    let db = open(dir.path());
    let folder = dir.path().join("archive").join(RESUME_FILES_DIR);
    let bytes = folder.join(&file.sha256);
    assert!(bytes.is_file());
    let result = db.delete_resume_file(&file.id).unwrap();
    assert!(clean(&result), "{result:?}");
    assert!(!bytes.exists());
    let listing = db.resume_file_listing().unwrap();
    assert!(listing.damaged.is_empty());
    assert_eq!(listing.files.len(), 5);
    assert!(listing.files.iter().all(|f| f.kind == ResumeFileKind::Photo && folder.join(&f.sha256).is_file()));
    // 没删到的（不存在的 id）不清理，也不报错。
    std::fs::write(folder.join("leftover"), b"x").unwrap();
    assert!(!db.delete_resume_file(&file.id).unwrap().deleted);
    assert!(folder.join("leftover").is_file());
}

#[test]
fn a_damaged_record_with_a_bad_hash_is_deleted_and_the_folder_is_checked_by_scanning() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let db = open(dir.path());
    let broken = db.add_resume_file(ResumeFileKind::Resume, "旧简历.pdf", &pdf(1)).unwrap();
    let kept = db.add_resume_file(ResumeFileKind::Photo, "照片.png", &png()).unwrap();
    db.close().unwrap();
    // 哈希写法不对（大写）：没法按哈希找到它的字节，只能扫附件目录看还有什么是备份清单不收的。
    let raw = rusqlite::Connection::open(cfg.db_path()).unwrap();
    raw.execute("UPDATE resume_files SET sha256 = upper(sha256) WHERE id = ?1", rusqlite::params![broken.id]).unwrap();
    drop(raw);
    let db = open(dir.path());
    let folder = dir.path().join("archive").join(RESUME_FILES_DIR);
    // 一份无关的残留在子目录里：清理只清这个目录下的文件，它会留着，备份会因为它停下。
    std::fs::create_dir_all(folder.join("sub")).unwrap();
    std::fs::write(folder.join("sub").join("stray"), b"x").unwrap();
    let result = db.delete_resume_file(&broken.id).unwrap();
    assert!(result.deleted);
    // 子目录不是附件文件：不挡备份，单独列出来让用户自己处理。
    assert!(result.folder.leftovers.is_empty(), "{result:?}");
    assert_eq!(result.folder.manual, vec![format!("{RESUME_FILES_DIR}/sub")]);
    assert!(result.folder.unchecked.is_none() && result.stuck_in_tmp.is_none(), "{result:?}");
    assert_eq!(db.check_resume_file_folder().manual, result.folder.manual);
    // 没有记录用着的那份字节清掉了，别的附件都在。
    assert!(!folder.join(&broken.sha256).exists());
    assert_eq!(db.read_resume_file(&kept.id).unwrap().1, png());
    // 残留拿掉以后，附件目录里没有备份清单不收的文件。
    std::fs::remove_dir_all(folder.join("sub")).unwrap();
    let check = db.check_resume_file_folder();
    assert!(check.leftovers.is_empty() && check.manual.is_empty() && check.unchecked.is_none());
}

#[test]
fn a_folder_that_cannot_be_checked_is_never_reported_clean() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let db = open(dir.path());
    let broken = db.add_resume_file(ResumeFileKind::Resume, "旧简历.pdf", &pdf(1)).unwrap();
    db.close().unwrap();
    let raw = rusqlite::Connection::open(cfg.db_path()).unwrap();
    raw.execute("UPDATE resume_files SET sha256 = 'not-a-hash' WHERE id = ?1", rusqlite::params![broken.id]).unwrap();
    drop(raw);
    // 附件目录变成了一个文件：读不了目录，核对不了还有没有残留。
    let folder = dir.path().join("archive").join(RESUME_FILES_DIR);
    std::fs::remove_dir_all(&folder).unwrap();
    std::fs::write(&folder, b"not a folder").unwrap();
    let db = open(dir.path());
    let result = db.delete_resume_file(&broken.id).unwrap();
    assert!(result.deleted, "the record is gone");
    assert!(result.folder.leftovers.is_empty());
    assert!(result.folder.unchecked.is_some(), "a failed check is not a clean result");
    assert!(db.check_resume_file_folder().unchecked.is_some());
}

#[test]
fn deleting_a_damaged_record_keeps_bytes_another_record_still_uses() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let db = open(dir.path());
    let healthy = db.add_resume_file(ResumeFileKind::Resume, "简历.pdf", &pdf(1)).unwrap();
    db.close().unwrap();
    // 表里 sha256 唯一，两条记录共用一份字节只会出现在改过的库里：重建一张没有这条约束的表来模拟，
    // 再加一条存储位置不对、哈希相同的坏记录。
    let damaged = "11111111-1111-4111-8111-111111111199";
    let raw = rusqlite::Connection::open(cfg.db_path()).unwrap();
    raw.execute_batch(&format!(
        "CREATE TABLE resume_files_copy AS SELECT * FROM resume_files;
         DROP TABLE resume_files;
         ALTER TABLE resume_files_copy RENAME TO resume_files;
         INSERT INTO resume_files SELECT '{damaged}', kind, '旧简历.pdf', label, mime, byte_size, sha256, 'elsewhere/old.pdf', 0,
           template_ids_json, position + 1, created_at, updated_at FROM resume_files WHERE id = '{}';",
        healthy.id
    ))
    .unwrap();
    drop(raw);
    let db = open(dir.path());
    let listing = db.resume_file_listing().unwrap();
    assert_eq!(listing.damaged.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(), vec![damaged]);
    // 删掉坏记录：另一条记录还用着这份字节，留着就对，算成功，也没有残留。
    let result = db.delete_resume_file(damaged).unwrap();
    assert!(clean(&result), "{result:?}");
    let folder = dir.path().join("archive").join(RESUME_FILES_DIR);
    assert!(folder.join(&healthy.sha256).is_file());
    assert_eq!(db.read_resume_file(&healthy.id).unwrap().1, pdf(1));
}

#[cfg(windows)]
#[test]
fn a_damaged_record_whose_bytes_are_held_is_not_deleted_and_a_held_stray_is_reported() {
    use std::os::windows::fs::OpenOptionsExt;
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let db = open(dir.path());
    let file = db.add_resume_file(ResumeFileKind::Resume, "简历.pdf", &pdf(1)).unwrap();
    db.close().unwrap();
    let raw = rusqlite::Connection::open(cfg.db_path()).unwrap();
    raw.execute_batch(&format!("UPDATE resume_files SET template_ids_json = 'not json' WHERE id = '{}'", file.id)).unwrap();
    drop(raw);
    let db = open(dir.path());
    let folder = dir.path().join("archive").join(RESUME_FILES_DIR);
    // 别的程序独占着这条记录的字节：和删能用的附件一样，挪不进 tmp/ 就什么都不删、照实报错。
    let held = std::fs::OpenOptions::new().read(true).share_mode(0).open(folder.join(&file.sha256)).unwrap();
    assert_eq!(code(db.delete_resume_file(&file.id).unwrap_err()), "validation_failed");
    assert_eq!(db.resume_file_listing().unwrap().damaged.len(), 1);
    assert!(folder.join(&file.sha256).is_file());
    drop(held);
    // 被占着删不掉的是一份无关的残留：记录和它的字节照常删掉，算成功，另外带上会挡住备份的那份残留。
    std::fs::write(folder.join("stray"), b"x").unwrap();
    let stray = std::fs::OpenOptions::new().read(true).share_mode(0).open(folder.join("stray")).unwrap();
    let result = db.delete_resume_file(&file.id).unwrap();
    assert!(result.deleted);
    assert_eq!(result.folder.leftovers, vec![format!("{RESUME_FILES_DIR}/stray")]);
    assert!(result.folder.unchecked.is_none() && result.stuck_in_tmp.is_none(), "{result:?}");
    assert!(!folder.join(&file.sha256).exists());
    drop(stray);
    // 放开以后，下一次增删附件时清掉。
    db.add_resume_file(ResumeFileKind::Photo, "照片.png", &png()).unwrap();
    assert!(db.check_resume_file_folder().leftovers.is_empty());
}

#[test]
fn a_record_whose_home_is_not_a_file_is_deleted_and_the_home_is_left_for_the_user() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(dir.path());
    let file = db.add_resume_file(ResumeFileKind::Resume, "简历.pdf", &pdf(1)).unwrap();
    let home = dir.path().join("archive").join(RESUME_FILES_DIR).join(&file.sha256);
    // 原位置上不是文件，是一个目录：那不是这条记录的字节。只删记录，不挪不删那个目录，把它列出来让用户处理。
    std::fs::remove_file(&home).unwrap();
    std::fs::create_dir(&home).unwrap();
    std::fs::write(home.join("inside"), b"x").unwrap();
    let result = db.delete_resume_file(&file.id).unwrap();
    assert!(result.deleted && result.stuck_in_tmp.is_none(), "{result:?}");
    assert_eq!(result.folder.manual, vec![format!("{RESUME_FILES_DIR}/{}", file.sha256)]);
    assert!(result.folder.leftovers.is_empty() && result.folder.unchecked.is_none(), "{result:?}");
    assert!(db.resume_file(&file.id).unwrap().is_none());
    assert!(home.join("inside").is_file());
    assert!(!dir.path().join("archive").join("tmp").join(format!("resume-file-{}.deleting", file.sha256)).exists());
    // 删不存在的记录也照样核对附件目录。
    let again = db.delete_resume_file(&file.id).unwrap();
    assert!(!again.deleted);
    assert_eq!(again.folder.manual, result.folder.manual);
}

#[test]
fn leftovers_in_tmp_are_swept_and_a_locked_file_is_not_reported_deleted() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(dir.path());
    let tmp = dir.path().join("archive").join("tmp");
    std::fs::create_dir_all(&tmp).unwrap();
    for name in ["resume-file-a.partial", "resume-file-b.deleting", "something-else.partial"] {
        std::fs::write(tmp.join(name), b"x").unwrap();
    }
    let file = db.add_resume_file(ResumeFileKind::Resume, "简历.pdf", &pdf(1)).unwrap();
    let mut names: Vec<_> = std::fs::read_dir(&tmp).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
    names.sort();
    assert_eq!(names, vec!["something-else.partial"], "only this table's own leftovers are swept");

    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let stored = dir.path().join("archive").join(RESUME_FILES_DIR).join(&file.sha256);
        // 别的程序独占着这个文件：什么都不删，照实报错，记录和字节都在。
        let held = std::fs::OpenOptions::new().read(true).share_mode(0).open(&stored).unwrap();
        let refused = db.delete_resume_file(&file.id).unwrap_err();
        assert_eq!(code(refused), "validation_failed");
        assert!(db.resume_file(&file.id).unwrap().is_some());
        assert!(stored.is_file());
        // 换文件时旧的被占着：新文件换上了，但不报成干净的成功。
        let replaced = db.replace_resume_file(&file.id, "新简历.pdf", &pdf(2)).unwrap_err();
        assert!(replaced.to_string().contains("旧文件正被别的程序占用"), "{replaced}");
        assert_eq!(db.resume_file(&file.id).unwrap().unwrap().name, "新简历.pdf");
        drop(held);
        let now = db.resume_file(&file.id).unwrap().unwrap();
        assert!(db.delete_resume_file(&now.id).unwrap().deleted);
        assert!(!stored.exists(), "the old bytes are swept once nothing holds them");
    }
    #[cfg(not(windows))]
    assert!(db.delete_resume_file(&file.id).unwrap().deleted);

    let leftovers: Vec<_> = std::fs::read_dir(dir.path().join("archive").join(RESUME_FILES_DIR)).unwrap().collect();
    assert!(leftovers.is_empty());
    assert!(!std::fs::read_dir(&tmp).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with("resume-file-")));
}

#[test]
fn the_first_file_of_a_kind_is_its_default_and_each_kind_keeps_one_default() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(dir.path());
    let first = db.add_resume_file(ResumeFileKind::Resume, "中文简历.pdf", &pdf(1)).unwrap();
    let second = db.add_resume_file(ResumeFileKind::Resume, "英文简历.pdf", &pdf(2)).unwrap();
    let photo = db.add_resume_file(ResumeFileKind::Photo, "证件照.jpg", &jpeg()).unwrap();
    assert!(first.is_default && !second.is_default && photo.is_default);
    db.update_resume_file(&second.id, &ResumeFilePatch { is_default: Some(true), ..Default::default() }).unwrap();
    let defaults: Vec<_> = db.resume_files().unwrap().into_iter().filter(|f| f.is_default).map(|f| f.name).collect();
    assert_eq!(defaults, vec!["英文简历.pdf", "证件照.jpg"]);
}

#[test]
fn names_labels_and_templates_are_checked_when_changed() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(dir.path());
    let file = db.add_resume_file(ResumeFileKind::Resume, "简历.pdf", &pdf(1)).unwrap();
    let fields = vec![TemplateField { key: "姓名".into(), value: "测试用户".into() }];
    let template = db.create_template("校招", vec![TemplateGroup { name: "基本信息".into(), fields }]).unwrap().template;
    let patch = |patch: ResumeFilePatch| db.update_resume_file(&file.id, &patch);
    for bad in ["简历.docx", "简历", "a/b.pdf", "token=abc.pdf", ""] {
        assert_eq!(code(patch(ResumeFilePatch { name: Some(bad.into()), ..Default::default() }).unwrap_err()), "validation_failed", "{bad}");
    }
    assert_eq!(code(patch(ResumeFilePatch { label: Some("password=1".into()), ..Default::default() }).unwrap_err()), "validation_failed");
    assert_eq!(code(patch(ResumeFilePatch { label: Some("很".repeat(31)), ..Default::default() }).unwrap_err()), "validation_failed");
    let other = "11111111-1111-4111-8111-111111111111".to_string();
    assert_eq!(code(patch(ResumeFilePatch { template_ids: Some(vec![other.clone()]), ..Default::default() }).unwrap_err()), "validation_failed");
    let changed = patch(ResumeFilePatch {
        name: Some(" 测试用户-简历.pdf ".into()),
        label: Some("中文".into()),
        template_ids: Some(vec![template.id.clone(), template.id.clone()]),
        ..Default::default()
    })
    .unwrap();
    assert_eq!((changed.name.as_str(), changed.label.as_str()), ("测试用户-简历.pdf", "中文"));
    assert_eq!(changed.template_ids, vec![template.id.clone()]);
    // 模板删掉以后绑定还带着它的 id：只绑了它的文件不变成空的「所有模板」，列表和单个读都一样。
    db.delete_template(&template.id).unwrap();
    let only_deleted = vec![template.id.clone()];
    assert_eq!(db.resume_file(&file.id).unwrap().unwrap().template_ids, only_deleted);
    assert_eq!(db.resume_files().unwrap()[0].template_ids, only_deleted);
    assert_eq!(db.resume_file_listing().unwrap().files[0].template_ids, only_deleted);
    // 改别的时它照样留着；已经绑着的删掉的模板可以留，新选一个不存在的不行。
    let relabeled = patch(ResumeFilePatch { label: Some("英文".into()), template_ids: Some(only_deleted.clone()), ..Default::default() }).unwrap();
    assert_eq!(relabeled.template_ids, only_deleted);
    assert_eq!(patch(ResumeFilePatch { label: Some("中文".into()), ..Default::default() }).unwrap().template_ids, only_deleted);
    let with_other = ResumeFilePatch { template_ids: Some(vec![template.id.clone(), other]), ..Default::default() };
    assert_eq!(code(patch(with_other).unwrap_err()), "validation_failed");
    // 用户自己取消了，才是所有模板；取消以后删掉的模板选不回来。
    assert!(patch(ResumeFilePatch { template_ids: Some(Vec::new()), ..Default::default() }).unwrap().template_ids.is_empty());
    assert_eq!(code(patch(ResumeFilePatch { template_ids: Some(only_deleted), ..Default::default() }).unwrap_err()), "validation_failed");
}

#[test]
fn the_same_content_is_kept_once_and_at_most_thirty_files() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(dir.path());
    db.add_resume_file(ResumeFileKind::Resume, "简历.pdf", &pdf(1)).unwrap();
    assert_eq!(code(db.add_resume_file(ResumeFileKind::Other, "副本.pdf", &pdf(1)).unwrap_err()), "validation_failed");
    for i in 1..MAX_RESUME_FILES {
        db.add_resume_file(ResumeFileKind::Other, &format!("材料{i}.pdf"), &pdf(10 + i)).unwrap();
    }
    assert_eq!(code(db.add_resume_file(ResumeFileKind::Other, "多一个.pdf", &pdf(99)).unwrap_err()), "validation_failed");
    assert_eq!(db.resume_files().unwrap().len(), MAX_RESUME_FILES);
}

#[test]
fn chunks_add_up_to_the_file_and_a_replaced_or_damaged_file_is_a_conflict() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(dir.path());
    let bytes = pdf(RESUME_FILE_CHUNK_BYTES * 2 + 100);
    let file = db.add_resume_file(ResumeFileKind::Resume, "简历.pdf", &bytes).unwrap();
    let mut joined = Vec::new();
    for index in 0..3 {
        let chunk = db.read_resume_file_chunk(&file.id, &file.sha256, index).unwrap();
        assert_eq!((chunk.chunk_index, chunk.chunk_count), (index, 3));
        joined.extend(chunk.bytes);
    }
    assert_eq!(joined, bytes);
    assert_eq!(code(db.read_resume_file_chunk(&file.id, &file.sha256, 3).unwrap_err()), "validation_failed");

    // 用户在桌面换了文件：拿旧版本的 sha256 来读就是冲突，读到一半也一样。
    let replaced = db.replace_resume_file(&file.id, "新简历.pdf", &pdf(5)).unwrap();
    assert_eq!((replaced.id.as_str(), replaced.name.as_str(), replaced.is_default), (file.id.as_str(), "新简历.pdf", true));
    assert_eq!(code(db.read_resume_file_chunk(&file.id, &file.sha256, 1).unwrap_err()), "conflict");
    assert_eq!(code(db.read_resume_file_chunk("11111111-1111-4111-8111-111111111111", &file.sha256, 0).unwrap_err()), "conflict");

    // 档案里的字节被改坏了：第 0 块就发现。
    let path = dir.path().join("archive").join(RESUME_FILES_DIR).join(&replaced.sha256);
    std::fs::write(&path, pdf(6)).unwrap();
    assert_eq!(code(db.read_resume_file_chunk(&replaced.id, &replaced.sha256, 0).unwrap_err()), "conflict");
    assert!(db.check_attachment_refs().unwrap().invalid_files.iter().any(|rel| rel.ends_with(&replaced.sha256)));
}

#[test]
fn deleting_and_replacing_remove_the_old_bytes_and_leftovers_are_swept() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(dir.path());
    let folder = dir.path().join("archive").join(RESUME_FILES_DIR);
    let first = db.add_resume_file(ResumeFileKind::Resume, "简历.pdf", &pdf(1)).unwrap();
    let replaced = db.replace_resume_file(&first.id, "简历.pdf", &pdf(2)).unwrap();
    assert!(!folder.join(&first.sha256).exists() && folder.join(&replaced.sha256).is_file());
    // 崩溃留下的、没人引用的文件：下一次增删时清掉。
    std::fs::write(folder.join("leftover"), b"x").unwrap();
    let photo = db.add_resume_file(ResumeFileKind::Photo, "照片.png", &png()).unwrap();
    assert!(!folder.join("leftover").exists());
    assert!(db.delete_resume_file(&photo.id).unwrap().deleted);
    assert!(!folder.join(&photo.sha256).exists());
    assert!(!db.delete_resume_file(&photo.id).unwrap().deleted);
    let names: Vec<_> = std::fs::read_dir(&folder).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(names, vec![std::ffi::OsString::from(&replaced.sha256)]);
}

#[test]
fn backups_list_every_resume_file_the_archive_refers_to() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(dir.path());
    let file = db.add_resume_file(ResumeFileKind::Resume, "简历.pdf", &pdf(3)).unwrap();
    let snapshot = dir.path().join("snapshot.db");
    db.snapshot_database_to(&snapshot).unwrap();
    let inventory = ArchiveStore::backup_inventory_from_snapshot(&snapshot).unwrap();
    let listed: Vec<_> = inventory.referenced_files.iter().map(|f| (f.path.clone(), f.size_bytes, f.sha256.clone())).collect();
    assert_eq!(listed, vec![(format!("{RESUME_FILES_DIR}/{}", file.sha256), file.byte_size, file.sha256.clone())]);
}

#[test]
fn a_v8_archive_gains_the_table_and_keeps_its_site_answers() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let old = ArchiveStore::open_with_migrations(cfg.clone(), &migration::MIGRATIONS[..8]).unwrap();
    old.save_site_answers(
        "campus.example.com",
        &[SiteAnswerInput { question: "是否有亲属在本公司工作".into(), answer: "否".into(), previous: None }],
    )
    .unwrap();
    old.close().unwrap();
    let upgraded = ArchiveStore::open(cfg).unwrap();
    assert_eq!(upgraded.schema_version(), current_schema_version());
    assert_eq!(upgraded.site_answers("campus.example.com").unwrap().len(), 1);
    upgraded.add_resume_file(ResumeFileKind::Resume, "简历.pdf", &pdf(1)).unwrap();
}

fn sha_of(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

#[test]
fn a_stored_path_anywhere_else_is_damage_and_no_file_is_touched() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let db = open(dir.path());
    let file = db.add_resume_file(ResumeFileKind::Resume, "简历.pdf", &pdf(1)).unwrap();
    db.close().unwrap();
    let outside = dir.path().join("outside.pdf");
    std::fs::write(&outside, pdf(2)).unwrap();
    let folder = dir.path().join("archive").join(RESUME_FILES_DIR);
    for (i, bad) in [
        outside.to_string_lossy().to_string(),
        format!("{RESUME_FILES_DIR}/../../outside.pdf"),
        "attachments/2026/11/outside.pdf".to_string(),
        format!("{RESUME_FILES_DIR}/{}", file.sha256.to_ascii_uppercase()),
        // 文件名和附件目录里的一个残留同名：残留照样清掉。
        dir.path().join("elsewhere").join("leftover").to_string_lossy().to_string(),
    ]
    .into_iter()
    .enumerate()
    {
        let raw = rusqlite::Connection::open(cfg.db_path()).unwrap();
        raw.execute("UPDATE resume_files SET stored_rel_path = ?1 WHERE id = ?2", rusqlite::params![bad, file.id]).unwrap();
        drop(raw);
        let db = open(dir.path());
        assert!(db.resume_files().unwrap().iter().all(|f| f.id != file.id), "{bad}");
        assert_eq!(db.resume_file_listing().unwrap().damaged[0].reason, "存储位置不对", "{bad}");
        assert_eq!(code(db.read_resume_file_chunk(&file.id, &file.sha256, 0).unwrap_err()), "internal_error", "{bad}");
        assert_eq!(code(db.read_resume_file(&file.id).unwrap_err()), "internal_error", "{bad}");
        assert_eq!(code(db.replace_resume_file(&file.id, "新简历.pdf", &pdf(3)).unwrap_err()), "internal_error", "{bad}");
        // 清理不因为这条记录停下，也不碰它指着的那个文件。引用按记录里的哈希认：这条记录的字节留着，
        // 它记的路径不进引用集合，和路径里的文件名同名的残留照样清掉。
        std::fs::write(folder.join("leftover"), b"x").unwrap();
        db.add_resume_file(ResumeFileKind::Other, &format!("材料{i}.pdf"), &pdf(10 + i)).unwrap();
        assert_eq!(std::fs::read(&outside).unwrap(), pdf(2), "the file outside the folder is untouched: {bad}");
        assert!(!folder.join("leftover").exists(), "{bad}");
        assert!(folder.join(&file.sha256).is_file(), "{bad}");
        // 备份清单不收这条记录，完整性检查把它报成有问题、不按它记的路径去读。
        let snapshot = dir.path().join(format!("snapshot{i}.db"));
        db.snapshot_database_to(&snapshot).unwrap();
        let inventory = ArchiveStore::backup_inventory_from_snapshot(&snapshot).unwrap();
        assert!(inventory.referenced_files.iter().all(|f| f.path != bad && f.sha256 != file.sha256), "{bad}");
        assert_eq!(inventory.referenced_files.len(), i + 1, "{bad}");
        assert!(db.check_attachment_refs().unwrap().invalid_files.contains(&bad), "{bad}");
        db.close().unwrap();
    }
    // 删掉这条记录：它记的路径不碰，档案外的文件原样在；它按哈希留在附件目录里的字节一起清掉。
    let db = open(dir.path());
    assert!(db.delete_resume_file(&file.id).unwrap().deleted);
    assert!(db.resume_file_listing().unwrap().damaged.is_empty());
    assert_eq!(std::fs::read(&outside).unwrap(), pdf(2));
    assert!(!folder.join(&file.sha256).exists());
    assert_eq!(std::fs::read_dir(&folder).unwrap().count(), 5, "the other files stay");
}

#[test]
fn a_stored_file_of_the_wrong_size_is_not_read_into_memory() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(dir.path());
    let file = db.add_resume_file(ResumeFileKind::Resume, "简历.pdf", &pdf(RESUME_FILE_CHUNK_BYTES + 10)).unwrap();
    let stored = dir.path().join("archive").join(RESUME_FILES_DIR).join(&file.sha256);
    std::fs::write(&stored, pdf(RESUME_FILE_CHUNK_BYTES * 3)).unwrap();
    assert_eq!(code(db.read_resume_file(&file.id).unwrap_err()), "conflict");
    for index in [0, 1] {
        assert_eq!(code(db.read_resume_file_chunk(&file.id, &file.sha256, index).unwrap_err()), "conflict", "{index}");
    }
}

#[test]
fn a_stale_file_at_the_same_place_is_replaced_and_a_failed_add_still_sweeps() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(dir.path());
    let folder = dir.path().join("archive").join(RESUME_FILES_DIR);
    std::fs::create_dir_all(&folder).unwrap();
    // 崩溃留下的、没人引用的一份坏文件，正好占着要添加的文件的位置。
    let bytes = pdf(40);
    std::fs::write(folder.join(sha_of(&bytes)), b"broken").unwrap();
    let file = db.add_resume_file(ResumeFileKind::Resume, "简历.pdf", &bytes).unwrap();
    assert_eq!(db.read_resume_file(&file.id).unwrap().1, bytes);
    // 添加被拒（同样的内容），残留也照样清掉。
    std::fs::write(folder.join("leftover"), b"x").unwrap();
    assert_eq!(code(db.add_resume_file(ResumeFileKind::Other, "副本.pdf", &bytes).unwrap_err()), "validation_failed");
    assert!(!folder.join("leftover").exists());
}

#[test]
fn bytes_left_half_deleted_while_their_record_remains_are_put_back_not_swept() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(dir.path());
    let file = db.add_resume_file(ResumeFileKind::Resume, "简历.pdf", &pdf(50)).unwrap();
    let folder = dir.path().join("archive").join(RESUME_FILES_DIR);
    let tmp = dir.path().join("archive").join("tmp");
    std::fs::create_dir_all(&tmp).unwrap();
    // 删记录失败、字节又没能挪回去：它还在 tmp/ 里，记录也还在。
    std::fs::rename(folder.join(&file.sha256), tmp.join(format!("resume-file-{}.deleting", file.sha256))).unwrap();
    db.add_resume_file(ResumeFileKind::Photo, "照片.png", &png()).unwrap();
    assert!(folder.join(&file.sha256).is_file());
    assert_eq!(db.read_resume_file(&file.id).unwrap().1, pdf(50));
    assert!(!tmp.join(format!("resume-file-{}.deleting", file.sha256)).exists());
}

#[test]
fn a_record_whose_size_or_type_is_wrong_is_damaged_not_a_panic() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let db = open(dir.path());
    let file = db.add_resume_file(ResumeFileKind::Resume, "简历.pdf", &pdf(1)).unwrap();
    db.close().unwrap();
    let too_big = MAX_RESUME_FILE_BYTES as i64 + 1;
    for (mime, size, reason) in [
        ("application/zip", file.byte_size, "文件类型不对"),
        ("image/png", file.byte_size, "文件类型不对"),
        ("", file.byte_size, "没有文件类型"),
        ("application/pdf", -5, "文件大小不对"),
        ("application/pdf", 0, "文件大小不对"),
        ("application/pdf", too_big, "文件大小不对"),
    ] {
        let raw = rusqlite::Connection::open(cfg.db_path()).unwrap();
        raw.execute_batch("PRAGMA ignore_check_constraints = ON;").unwrap();
        raw.execute("UPDATE resume_files SET mime = ?1, byte_size = ?2 WHERE id = ?3", rusqlite::params![mime, size, file.id]).unwrap();
        drop(raw);
        let db = open(dir.path());
        let listing = db.resume_file_listing().unwrap();
        assert!(listing.files.is_empty(), "{mime} {size}");
        assert_eq!(listing.damaged[0].reason, reason, "{mime} {size}");
        let renamed = db.update_resume_file(&file.id, &ResumeFilePatch { name: Some("新.pdf".into()), ..Default::default() });
        assert_eq!(code(renamed.unwrap_err()), "internal_error", "{mime} {size}");
        assert_eq!(code(db.read_resume_file_chunk(&file.id, &file.sha256, 0).unwrap_err()), "internal_error", "{mime} {size}");
        db.close().unwrap();
    }
}
