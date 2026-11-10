use archive_store::notes::{NoteChange, NoteDraft, NoteUpload};
use archive_store::{ArchiveConfig, ArchiveStore};

const NOTE: &str = "80d0955c-9698-4ea9-b764-bcc5c10cde34";
const IMAGE: &str = "5a764a7a-e662-4bbd-ada5-f73001c219ef";
const BAD_IMAGE: &str = "2f46a76f-c081-4d47-b977-e747fd3af1af";
const PNG: &[u8] = b"\x89PNG\r\n\x1a\nprivate";

fn add_folder(store: &ArchiveStore, name: &str) -> String {
    store
        .change_note(NoteChange::Folder {
            id: None,
            name: name.into(),
            application_id: None,
        })
        .unwrap()
        .unwrap()
}

fn draft(folder: &str, text: &str, ids: &[&str]) -> NoteDraft {
    NoteDraft {
        id: NOTE.into(),
        folder_id: folder.into(),
        title: "".into(),
        record_date: "2026-11-09".into(),
        body: format!("<p>{text}</p>"),
        plain_text: text.into(),
        file_ids: ids.iter().map(|id| (*id).into()).collect(),
    }
}

fn upload(id: &str, bytes: &[u8]) -> NoteUpload {
    NoteUpload {
        id: id.into(),
        name: "截图.png".into(),
        bytes: bytes.to_vec(),
    }
}

#[test]
fn image_failure_preserves_the_previous_save_and_retry_has_one_attachment() {
    let dir = tempfile::tempdir().unwrap();
    let config = ArchiveConfig::new(dir.path().join("archive"), dir.path().join("current.json"));
    let store = ArchiveStore::open(config.clone()).unwrap();
    let folder = add_folder(&store, "数据分析");
    store
        .save_note(draft(&folder, "原文", &[]), vec![])
        .unwrap();

    let invalid = store.save_note(
        draft(&folder, "包含两张图", &[IMAGE, BAD_IMAGE]),
        vec![upload(IMAGE, PNG), upload(BAD_IMAGE, b"<svg/>")],
    );
    assert!(invalid.is_err());
    assert_eq!(store.note_body(NOTE).unwrap(), "<p>原文</p>");
    assert!(store.read_note_file(IMAGE).is_err());
    assert!(!store
        .archive_dir()
        .join(format!("attachments/notes/{IMAGE}"))
        .exists());

    for _ in 0..2 {
        store
            .save_note(draft(&folder, "新正文", &[IMAGE]), vec![upload(IMAGE, PNG)])
            .unwrap();
    }
    store
        .change_note(NoteChange::Ocr {
            id: IMAGE.into(),
            text: "ROW_NUMBER".into(),
        })
        .unwrap();
    store.close().unwrap();

    let store = ArchiveStore::open(config).unwrap();
    let index = serde_json::to_value(store.note_index().unwrap()).unwrap();
    assert_eq!(index["notes"][0]["files"].as_array().unwrap().len(), 1);
    assert_eq!(index["notes"][0]["files"][0]["ocrText"], "ROW_NUMBER");
    assert_eq!(store.read_note_file(IMAGE).unwrap().2, PNG);

    store
        .save_note(draft(&folder, "只留正文", &[]), vec![])
        .unwrap();
    assert!(!store
        .archive_dir()
        .join(format!("attachments/notes/{IMAGE}"))
        .exists());
}

#[test]
fn move_recycle_and_restore_keep_the_same_note_identity_and_image() {
    let dir = tempfile::tempdir().unwrap();
    let store = ArchiveStore::open(ArchiveConfig::new(
        dir.path().join("archive"),
        dir.path().join("current.json"),
    ))
    .unwrap();
    let source = add_folder(&store, "一面");
    let target = add_folder(&store, "二面");
    store
        .save_note(draft(&source, "复盘", &[IMAGE]), vec![upload(IMAGE, PNG)])
        .unwrap();
    store
        .change_note(NoteChange::Favorite {
            id: NOTE.into(),
            favorite: true,
        })
        .unwrap();
    store
        .change_note(NoteChange::Move {
            id: NOTE.into(),
            folder_id: target.clone(),
        })
        .unwrap();
    for recycled in [true, false] {
        store
            .change_note(NoteChange::RecycleFolder {
                id: target.clone(),
                recycled,
            })
            .unwrap();
        let index = serde_json::to_value(store.note_index().unwrap()).unwrap();
        let folder = index["folders"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == target)
            .unwrap();
        assert_eq!(folder["recycled"], recycled);
        assert_eq!(index["notes"][0]["id"], NOTE);
        assert_eq!(index["notes"][0]["folderId"], target);
        assert_eq!(index["notes"][0]["favorite"], true);
        assert_eq!(store.read_note_file(IMAGE).unwrap().2, PNG);
    }
}
