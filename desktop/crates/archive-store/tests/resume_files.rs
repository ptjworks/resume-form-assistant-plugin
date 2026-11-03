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
    out.extend(le16(0));
    out
}

fn docx() -> Vec<u8> {
    zip(&[("[Content_Types].xml", b"<Types/>"), ("_rels/.rels", b"<Relationships/>"), ("word/document.xml", b"<w:document/>")])
}

fn code(error: StoreError) -> &'static str {
    error.code()
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
    assert_eq!(code(patch(ResumeFilePatch { template_ids: Some(vec![other]), ..Default::default() }).unwrap_err()), "validation_failed");
    let changed = patch(ResumeFilePatch {
        name: Some(" 测试用户-简历.pdf ".into()),
        label: Some("中文".into()),
        template_ids: Some(vec![template.id.clone(), template.id.clone()]),
        ..Default::default()
    })
    .unwrap();
    assert_eq!((changed.name.as_str(), changed.label.as_str()), ("测试用户-简历.pdf", "中文"));
    assert_eq!(changed.template_ids, vec![template.id.clone()]);
    // 模板删掉以后，列表里不再带着它。
    db.delete_template(&template.id).unwrap();
    assert!(db.resume_file(&file.id).unwrap().unwrap().template_ids.is_empty());
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
    assert!(db.delete_resume_file(&photo.id).unwrap());
    assert!(!folder.join(&photo.sha256).exists());
    assert!(!db.delete_resume_file(&photo.id).unwrap());
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
