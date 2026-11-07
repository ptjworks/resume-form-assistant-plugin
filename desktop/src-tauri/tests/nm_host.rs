//! Drives the real binary over stdio, the way a browser would. No registration, no
//! browser, no system state.
//!
//! Every process started here gets its own data directory and
//! `RESUMEPRO_SKIP_NM_REGISTRATION=1`. A desktop on a fresh data directory otherwise points
//! the per-user Native Messaging registration at that directory, and once the test deletes
//! it the installed app can no longer be reached from the browser.

use std::io::Write;
use std::process::{Command, Stdio};

/// Keeps the desktop off the machine's Native Messaging registration. Development builds
/// only, which is why the tests that start a real desktop are skipped in release builds.
const SKIP_NM_REGISTRATION: (&str, &str) = ("RESUMEPRO_SKIP_NM_REGISTRATION", "1");

const HEALTH: &str = r#"{"protocolVersion":1,"messageId":"33333333-3333-4333-8333-333333333333","clientInstanceId":"11111111-1111-4111-8111-111111111111","messageType":"health","occurredAt":"2026-09-06T12:00:00.000Z","payload":{}}"#;
const ORIGIN: &str = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";
const HANDSHAKE: &str = r#"{"protocolVersion":2,"messageId":"33333333-3333-4333-8333-333333333333","clientInstanceId":"11111111-1111-4111-8111-111111111111","messageType":"handshake","occurredAt":"2026-09-06T12:00:00.000Z","payload":{"pluginVersion":"0.4.1","minProtocolVersion":2,"maxProtocolVersion":2}}"#;

#[test]
fn an_explicit_quit_survives_new_native_hosts_and_delayed_hidden_launches() {
    let tmp = tempfile::tempdir().unwrap();
    let policy = data_service::launch_policy::LaunchGuard::acquire(tmp.path(), std::time::Duration::ZERO).unwrap();
    policy.record_quit().unwrap();
    drop(policy);
    for _ in 0..3 {
        // The released store extension is allowed even with a fresh pairing file.
        // Use the same caller as the Windows installed-package diagnostic.
        let (code, stdout, stderr) = run_host_with_data_dir(
            &["chrome-extension://diagjmploldedipjdenmecmjokckelkl/"], tmp.path(), framed(HANDSHAKE));
        assert_eq!(code, 0, "{stderr}");
        let reply: serde_json::Value = serde_json::from_slice(&stdout[4..]).unwrap();
        assert_eq!(reply["error"]["code"], "unavailable");
        assert_eq!(reply["error"]["retryable"], true, "queued work must remain retryable");
    }
    // This is the actual binary's preflight, not a mocked startup policy. It must
    // return before creating a GUI, archive, or Native Messaging registration.
    let (code, _, _) = run_host_with_data_dir(&["--hidden"], tmp.path(), Vec::new());
    assert_eq!(code, 0);
    assert!(!tmp.path().join("archive").exists());
    assert!(tmp.path().join("explicit-quit").exists());
    let marker = std::fs::read(tmp.path().join("explicit-quit")).unwrap();
    let _ = run_host_with_data_dir(&["--probe"], tmp.path(), Vec::new());
    assert_eq!(std::fs::read(tmp.path().join("explicit-quit")).unwrap(), marker,
        "diagnostics must not clear the explicit quit state");
}

fn framed(body: &str) -> Vec<u8> {
    let mut wire = (body.len() as u32).to_ne_bytes().to_vec();
    wire.extend_from_slice(body.as_bytes());
    wire
}

/// Send `input` to a fresh host process started with `args`, and return
/// (exit code, stdout, stderr).
fn run_host(args: &[&str], input: Vec<u8>) -> (i32, Vec<u8>, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_resume-pro-desktop"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the binary must start");
    child
        .stdin
        .take()
        .expect("stdin is piped")
        .write_all(&input)
        .expect("the host must accept input");
    let output = child.wait_with_output().expect("the host must exit");
    (
        output.status.code().unwrap_or(-1),
        output.stdout,
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

/// Assert `stdout` is one successful health frame and nothing else.
///
/// The body is compared field by field rather than to a fixed byte string, because
/// serde_json orders keys alphabetically rather than as written. The strict part is kept
/// another way: stdout must be exactly the prefix plus the length it declares, which is
/// what proves no stray byte rode along.
fn assert_single_health_frame(stdout: &[u8]) {
    assert!(stdout.len() > 4, "stdout is too short to be a frame");
    let declared = u32::from_ne_bytes(stdout[..4].try_into().unwrap()) as usize;
    assert_eq!(
        stdout.len(),
        4 + declared,
        "stdout must be exactly one protocol frame with nothing after it"
    );
    let body: serde_json::Value =
        serde_json::from_slice(&stdout[4..]).expect("the frame body must be JSON");
    assert_eq!(body["protocolVersion"], 1);
    assert_eq!(body["ok"], true);
    assert_eq!(
        body["correlationId"],
        "33333333-3333-4333-8333-333333333333"
    );
    assert_eq!(body["payload"], serde_json::json!({}));
    assert!(body.get("error").is_none());
}

#[test]
fn the_test_entry_point_behaves_identically() {
    let (code, stdout, _stderr) = run_host(&["--nm-host"], framed(HEALTH));
    assert_eq!(code, 0);
    assert_single_health_frame(&stdout);
}

#[test]
fn the_caller_origin_is_recorded_on_stderr() {
    let tmp = isolated_data_dir("origin-recorded");
    let (_code, _stdout, stderr) = run_host_with_data_dir(&[ORIGIN], &tmp, framed(HEALTH));
    assert!(
        stderr.contains(ORIGIN),
        "the caller must be recorded: {stderr}"
    );
}

#[test]
fn a_closed_port_exits_cleanly_and_prints_nothing() {
    let (code, stdout, stderr) = run_host(&["--nm-host"], Vec::new());
    assert_eq!(code, 0);
    assert!(stdout.is_empty());
    // stderr carries one line naming the caller; a clean close must add no failure.
    assert!(
        !stderr.contains("cannot") && !stderr.contains("closing"),
        "a clean close is not an error: {stderr}"
    );
}

#[test]
fn an_oversized_prefix_is_refused_on_stderr_and_stdout_stays_empty() {
    let mut wire = u32::MAX.to_ne_bytes().to_vec();
    wire.extend_from_slice(b"body");
    let (code, stdout, stderr) = run_host(&["--nm-host"], wire);
    assert_eq!(code, 2);
    assert!(stdout.is_empty(), "a refusal must not put bytes on stdout");
    assert!(
        stderr.contains("nm-host"),
        "the reason must reach stderr: {stderr}"
    );
}

#[test]
fn newline_bytes_in_a_request_survive_the_round_trip() {
    // Text-mode stdio would rewrite 0x0A as 0x0D 0x0A and corrupt the frame. ADR 3.7
    // requires binary stdout; this asserts it end to end through the real process.
    let pretty = "{\n  \"protocolVersion\": 1,\n  \"messageId\": \"33333333-3333-4333-8333-333333333333\",\n  \"clientInstanceId\": \"11111111-1111-4111-8111-111111111111\",\n  \"messageType\": \"health\",\n  \"occurredAt\": \"2026-09-06T12:00:00.000Z\",\n  \"payload\": {}\n}";
    assert!(pretty.contains('\n'));
    let (code, stdout, _stderr) = run_host(&["--nm-host"], framed(pretty));
    assert_eq!(code, 0);
    assert_single_health_frame(&stdout);
    assert!(
        !stdout.contains(&b'\r'),
        "stdout must not gain carriage returns"
    );
}

/// Run a host whose data directory is `data_dir`, so the pairing settings under test are
/// the only ones it can see. `RESUMEPRO_DATA_DIR` is the same override D02 uses.
fn run_host_with_data_dir(
    args: &[&str],
    data_dir: &std::path::Path,
    input: Vec<u8>,
) -> (i32, Vec<u8>, String) {
    // A desktop the host cold-starts inherits this environment, the switch included.
    let mut child = Command::new(env!("CARGO_BIN_EXE_resume-pro-desktop"))
        .args(args)
        .env("RESUMEPRO_DATA_DIR", data_dir)
        .env(SKIP_NM_REGISTRATION.0, SKIP_NM_REGISTRATION.1)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the binary must start");
    child
        .stdin
        .take()
        .expect("stdin is piped")
        .write_all(&input)
        .expect("the host must accept input");
    let output = child.wait_with_output().expect("the host must exit");
    (
        output.status.code().unwrap_or(-1),
        output.stdout,
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

/// A data directory of this test's own, so the developer's real ResumePro directory is
/// never read or created by the suite.
fn isolated_data_dir(label: &str) -> DataDir {
    let dir = std::env::temp_dir().join(format!("rp-nm-{label}-{}", std::process::id()));
    std::fs::remove_dir_all(&dir).ok();
    std::fs::create_dir_all(&dir).unwrap();
    DataDir(dir)
}

/// Removed on drop, also when the test fails. Declare it before anything that runs in it,
/// so that it is dropped after them.
struct DataDir(std::path::PathBuf);

impl std::ops::Deref for DataDir {
    type Target = std::path::Path;

    fn deref(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for DataDir {
    fn drop(&mut self) {
        // Windows will not delete a file that is still open, and a virus scanner can hold a
        // freshly written one for a moment. A directory still there after that is a leak,
        // and fails the test rather than piling up in the temp directory.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let err = match std::fs::remove_dir_all(&self.0) {
                Ok(()) => return,
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => return,
                Err(err) => err,
            };
            if std::time::Instant::now() >= deadline {
                let message = format!("the test data directory {} was left behind: {err}", self.0.display());
                if std::thread::panicking() {
                    eprintln!("{message}");
                    return;
                }
                panic!("{message}");
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }
}

fn error_code_of(stdout: &[u8]) -> String {
    assert!(stdout.len() > 4, "stdout is too short to be a frame");
    let declared = u32::from_ne_bytes(stdout[..4].try_into().unwrap()) as usize;
    assert_eq!(
        stdout.len(),
        4 + declared,
        "stdout must be exactly one frame"
    );
    let body: serde_json::Value = serde_json::from_slice(&stdout[4..]).unwrap();
    assert_eq!(body["ok"], false);
    body["error"]["code"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

#[test]
fn an_unpaired_caller_is_refused_per_message_and_the_port_stays_open() {
    // Nothing is paired in this data directory, so the caller cannot be authorised.
    let tmp = isolated_data_dir("unpaired");

    let mut two = framed(HEALTH);
    two.extend_from_slice(&framed(HEALTH));
    let (code, stdout, stderr) = run_host_with_data_dir(&[ORIGIN], &tmp, two);

    assert_eq!(code, 0, "the port must not be dropped: {stderr}");
    assert!(
        stderr.contains("not paired"),
        "the reason must reach stderr: {stderr}"
    );
    // Two requests, two refusals, nothing else.
    let first = u32::from_ne_bytes(stdout[..4].try_into().unwrap()) as usize;
    assert_eq!(error_code_of(&stdout[..4 + first]), "identity_not_allowed");
    assert_eq!(error_code_of(&stdout[4 + first..]), "identity_not_allowed");
}

#[test]
fn a_paired_caller_is_served() {
    let tmp = isolated_data_dir("paired");
    // The shape D02's pairing form saves.
    std::fs::write(
        tmp.join("settings.json"),
        r#"{"chromeExtensionId":"abcdefghijklmnopabcdefghijklmnop","edgeExtensionId":""}"#,
    )
    .unwrap();

    let (code, stdout, stderr) = run_host_with_data_dir(&[ORIGIN], &tmp, framed(HEALTH));
    assert_eq!(code, 0);
    assert!(
        stderr.contains("authorised"),
        "the caller must be recorded as authorised: {stderr}"
    );
    assert_single_health_frame(&stdout);
}

#[test]
fn the_test_entry_point_never_touches_the_real_settings() {
    // A relative RESUMEPRO_DATA_DIR makes path resolution fail, which the host reports on
    // stderr. With no origin there is nothing to authorise, so pairing must not be
    // consulted at all and that message must not appear. Without this the --nm-host tests
    // read the developer's real ResumePro settings, which is what the isolation added
    // alongside was supposed to prevent.
    let (code, stdout, stderr) = run_host_with_data_dir(
        &["--nm-host"],
        std::path::Path::new("relative-not-absolute"),
        framed(HEALTH),
    );
    assert_eq!(code, 0);
    assert_single_health_frame(&stdout);
    assert!(
        !stderr.contains("cannot resolve data paths"),
        "pairing must not be read when there is no origin: {stderr}"
    );
}

#[test]
fn an_origin_does_make_the_host_consult_pairing() {
    // The counterpart to the test above: with an origin, resolution is attempted, so the
    // same broken override is reported. This is what proves the previous test observes a
    // real difference rather than a message that never appears.
    let (code, _stdout, stderr) = run_host_with_data_dir(
        &[ORIGIN],
        std::path::Path::new("relative-not-absolute"),
        framed(HEALTH),
    );
    assert_eq!(code, 0);
    assert!(
        stderr.contains("cannot resolve data paths"),
        "an origin must send the host to pairing: {stderr}"
    );
}

// ---------------------------------------------------------------------------
// End to end: a real host process reaching a real application process.
// ---------------------------------------------------------------------------

const JOB_SAVE: &str = r#"{"protocolVersion":1,"messageId":"44444444-4444-4444-8444-444444444444","clientInstanceId":"11111111-1111-4111-8111-111111111111","messageType":"job.save","occurredAt":"2026-09-06T12:00:00.000Z","payload":{"sourceRestoreEpoch":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","company":"合成公司","title":"后端实习","payloadSha256":"1ea8fcf15e56dd83a5e7f8e9adb0c34b94bc28fd5c1b51400ecf597d1f5cc8c4"},"archiveId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","restoreEpoch":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}"#;

fn error_of(stdout: &[u8]) -> (String, bool) {
    assert!(stdout.len() > 4, "stdout is too short to be a frame");
    let declared = u32::from_ne_bytes(stdout[..4].try_into().unwrap()) as usize;
    assert_eq!(
        stdout.len(),
        4 + declared,
        "stdout must be exactly one frame"
    );
    let body: serde_json::Value = serde_json::from_slice(&stdout[4..]).unwrap();
    (
        body["error"]["code"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        body["ok"].as_bool().unwrap_or(false),
    )
}

fn paired_dir(label: &str) -> DataDir {
    let dir = isolated_data_dir(label);
    std::fs::write(
        dir.join("settings.json"),
        format!(
            r#"{{"chromeExtensionId":"{}","edgeExtensionId":""}}"#,
            EXT_ID
        ),
    )
    .unwrap();
    dir
}

const EXT_ID: &str = "abcdefghijklmnopabcdefghijklmnop";

#[test]
fn a_request_the_host_cannot_answer_alone_is_not_reported_as_success() {
    // A relative RESUMEPRO_DATA_DIR leaves no data directory to reach an application in,
    // so the host has nowhere to forward to. It must say the service is unavailable
    // rather than invent a successful write.
    //
    // The data directory is deliberately unusable rather than merely empty: a usable one
    // would send the host into a real cold start, launching a desktop application from
    // the test suite and leaving it running.
    let (code, stdout, stderr) = run_host_with_data_dir(
        &["--nm-host"],
        std::path::Path::new("relative-not-absolute"),
        framed(JOB_SAVE),
    );
    assert_eq!(code, 0, "{stderr}");
    let (error, ok) = error_of(&stdout);
    assert!(
        !ok,
        "a write with nothing behind it must not report success"
    );
    assert_eq!(error, "unavailable", "and must be retryable: {stderr}");
}

#[test]
fn health_is_answered_without_starting_the_application() {
    // health asks nothing of the archive, so routing it through the application would put
    // a cold start in front of a liveness check. An empty but usable data directory means
    // nothing is listening, so a health that waited would take the full cold-start budget.
    let tmp = paired_dir("health-alone");
    let started = std::time::Instant::now();
    let (code, stdout, _stderr) = run_host_with_data_dir(&[ORIGIN], &tmp, framed(HEALTH));
    assert_eq!(code, 0);
    assert_single_health_frame(&stdout);
    assert!(
        started.elapsed() < std::time::Duration::from_secs(5),
        "health must not wait on a cold start"
    );
}

#[cfg(unix)]
fn relay_v2_through_real_host(kind: &str, payload: serde_json::Value, response_payload: serde_json::Value) {
    let tmp = paired_dir(&format!("v2-{}", kind.replace('.', "-")));
    let endpoint = local_ipc::Endpoint::for_data_root(&tmp).unwrap();
    let mut listener = local_ipc::Listener::bind(&endpoint).unwrap();
    let kind_owned = kind.to_string();
    let responder = std::thread::spawn(move || {
        // connect_or_start first probes the endpoint and closes that connection.
        // The following connection carries the actual request frame.
        let frame;
        let mut stream;
        loop {
            stream = listener.accept().unwrap();
            if let Some(next) = nm_frame::read_frame(&mut stream).unwrap() {
                frame = next;
                break;
            }
        }
        let request: serde_json::Value = serde_json::from_slice(&frame).unwrap();
        assert_eq!(request["messageType"], kind_owned);
        assert_eq!(request["protocolVersion"], 2);
        let reply = serde_json::json!({
            "protocolVersion": 2,
            "correlationId": request["messageId"],
            "ok": true,
            "payload": response_payload
        });
        nm_frame::write_frame(&mut stream, &serde_json::to_vec(&reply).unwrap()).unwrap();
    });
    let mut request = serde_json::json!({
        "protocolVersion": 2,
        "messageId": "33333333-3333-4333-8333-333333333333",
        "clientInstanceId": "11111111-1111-4111-8111-111111111111",
        "messageType": kind,
        "occurredAt": "2026-09-24T00:00:00.000Z",
        "payload": payload
    });
    if kind == "resume.read" {
        request["archiveId"] = serde_json::json!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        request["restoreEpoch"] = serde_json::json!("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    }
    let (code, stdout, stderr) = run_host_with_data_dir(&[ORIGIN], &tmp, framed(&request.to_string()));
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.len() > 4, "host returned no response: {stderr}");
    responder.join().unwrap();
    let declared = u32::from_ne_bytes(stdout[..4].try_into().unwrap()) as usize;
    assert_eq!(stdout.len(), declared + 4);
    let reply: serde_json::Value = serde_json::from_slice(&stdout[4..]).unwrap();
    assert_eq!(reply["protocolVersion"], 2);
    assert_eq!(reply["ok"], true);
    assert_eq!(reply["correlationId"], request["messageId"]);
    resume_pro_protocol::validate_response_value(&reply, resume_pro_protocol::MessageType::parse(kind).unwrap()).unwrap();
}

#[cfg(unix)]
#[test]
fn v2_resume_read_and_ui_open_cross_the_real_host_process() {
    relay_v2_through_real_host("resume.read", serde_json::json!({}), serde_json::json!({
        "templates": [], "activeTemplate": null,
        "profile": {"values":{},"family":[],"custom":[]}, "profileRevision": 0
    }));
    relay_v2_through_real_host("ui.open", serde_json::json!({"view":"home"}), serde_json::json!({"opened":true}));
}

#[cfg(windows)]
#[test]
fn v2_requests_keep_their_version_when_the_real_host_has_no_application() {
    // Windows verifies that the pipe server runs the same executable as the host. A
    // fake server in this integration-test process must therefore be refused; the
    // real application path is covered by ipc_server's in-process archive tests.
    for (kind, payload, with_identity) in [
        ("resume.read", serde_json::json!({}), true),
        ("ui.open", serde_json::json!({"view":"home"}), false),
    ] {
        let mut request = serde_json::json!({
            "protocolVersion": 2,
            "messageId": "33333333-3333-4333-8333-333333333333",
            "clientInstanceId": "11111111-1111-4111-8111-111111111111",
            "messageType": kind,
            "occurredAt": "2026-09-24T00:00:00.000Z",
            "payload": payload
        });
        if with_identity {
            request["archiveId"] = serde_json::json!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
            request["restoreEpoch"] = serde_json::json!("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
        }
        let (code, stdout, stderr) = run_host_with_data_dir(
            &["--nm-host"], std::path::Path::new("relative-not-absolute"), framed(&request.to_string()),
        );
        assert_eq!(code, 0, "{stderr}");
        assert_eq!(error_code_of(&stdout), "unavailable");
        let reply: serde_json::Value = serde_json::from_slice(&stdout[4..]).unwrap();
        assert_eq!(reply["protocolVersion"], 2);
    }
}

/// How long a hidden desktop may take to reach each step these tests wait for.
///
/// Every run starts it on a brand-new data directory, so WebView2 has to build a new profile
/// under `cache\webview`. That takes about a second on a warm machine and has run past 10
/// seconds on a GitHub Windows runner, and a freshly linked executable is also scanned on its
/// first launch. This budget only bounds a hang: a desktop that exits early is reported at once.
#[cfg(windows)]
const HIDDEN_DESKTOP_STARTUP_BUDGET: std::time::Duration = std::time::Duration::from_secs(60);

/// A second desktop hands its launch to the running one and exits, so the tests that start
/// the real desktop take turns.
#[cfg(windows)]
static ONE_DESKTOP_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(windows)]
struct HiddenApplication {
    child: std::process::Child,
    /// The desktop and everything it starts, WebView2's processes included.
    processes: ProcessTree,
    data_dir: std::path::PathBuf,
    _turn: std::sync::MutexGuard<'static, ()>,
}

#[cfg(windows)]
impl HiddenApplication {
    /// Start the real desktop with `--hidden` on `data_dir`. Its stderr goes to a file in
    /// that directory, so a failed start can say what the desktop reported.
    fn start(data_dir: &std::path::Path) -> Self {
        // A test that failed while holding the turn has already stopped its desktop.
        let turn = ONE_DESKTOP_AT_A_TIME.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let stderr = std::fs::File::create(data_dir.join("desktop-stderr.log")).unwrap();
        let child = Command::new(env!("CARGO_BIN_EXE_resume-pro-desktop"))
            .arg("--hidden")
            .env("RESUMEPRO_DATA_DIR", data_dir)
            .env(SKIP_NM_REGISTRATION.0, SKIP_NM_REGISTRATION.1)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(stderr)
            .spawn()
            .expect("isolated hidden desktop must start");
        // WebView2 starts after the archive is open, long after this.
        let processes = match ProcessTree::adopt(&child) {
            Ok(processes) => processes,
            Err(problem) => {
                // Outside a job nothing else would stop it.
                let mut child = child;
                let _ = child.kill();
                let _ = child.wait();
                panic!("{problem}");
            }
        };
        HiddenApplication { child, processes, data_dir: data_dir.to_path_buf(), _turn: turn }
    }

    /// Wait for the desktop to open an archive and return the pointer it wrote.
    fn wait_for_archive(&mut self) -> serde_json::Value {
        let pointer = self.data_dir.join("current.json");
        self.wait_for("opening an archive", || {
            serde_json::from_slice(&std::fs::read(&pointer).ok()?).ok()
        })
    }

    /// Poll `ready` until it yields a value. A desktop that exits first fails at once; one
    /// that is still running fails at the budget.
    fn wait_for<T>(&mut self, step: &str, mut ready: impl FnMut() -> Option<T>) -> T {
        let started = std::time::Instant::now();
        loop {
            if let Some(value) = ready() {
                return value;
            }
            if let Some(status) = self.child.try_wait().expect("the desktop can be polled") {
                let hint = if status.success() {
                    " (is another Resume Pro Desktop already running?)"
                } else {
                    ""
                };
                panic!(
                    "the hidden desktop exited ({status}) before {step}{hint}\n{}",
                    self.startup_report(started.elapsed())
                );
            }
            if started.elapsed() >= HIDDEN_DESKTOP_STARTUP_BUDGET {
                panic!(
                    "the desktop was still short of {step} after {HIDDEN_DESKTOP_STARTUP_BUDGET:?}\n{}",
                    self.startup_report(started.elapsed())
                );
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }

    /// Which startup steps finished, in the order the desktop takes them, and what it said.
    fn startup_report(&self, elapsed: std::time::Duration) -> String {
        let done = |step: &str| if self.data_dir.join(step).exists() { "yes" } else { "no" };
        let stderr = std::fs::read_to_string(self.data_dir.join("desktop-stderr.log"))
            .unwrap_or_else(|err| format!("<unreadable: {err}>"));
        format!(
            "after {elapsed:?}: host.lock taken: {}, current.json written: {}, WebView2 profile created: {}\ndesktop stderr:\n{stderr}",
            done("host.lock"),
            done("current.json"),
            done("cache/webview/EBWebView"),
        )
    }
}

#[cfg(windows)]
impl Drop for HiddenApplication {
    fn drop(&mut self) {
        // Killing only the desktop leaves WebView2 running for a while with its profile under
        // the data directory open, so the directory could not be removed after the test.
        let mut problems = Vec::new();
        if !self.processes.terminate() {
            problems.push(format!("cannot terminate the desktop's job object: {}", std::io::Error::last_os_error()));
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
        if let Err(problem) = self.processes.wait_until_empty(std::time::Duration::from_secs(10)) {
            problems.push(problem);
        }
        // Checked once every process has exited, so nothing the desktop does later can be missed.
        match registrations_into(&self.data_dir) {
            Ok(found) if found.is_empty() => {}
            Ok(found) => problems.push(format!(
                "the desktop under test re-pointed the browser at its temporary data directory: {}",
                found.join("; ")
            )),
            Err(problem) => problems.push(problem),
        }
        if problems.is_empty() {
            return;
        }
        // A second panic while unwinding would abort the run and hide the first failure.
        let message = problems.join("\n");
        if std::thread::panicking() {
            eprintln!("{message}");
        } else {
            panic!("{message}");
        }
    }
}

/// A Job Object holding the desktop under test. Processes the desktop starts join it, and it
/// is set to kill them all when its last handle closes, so even a test run that is
/// interrupted does not leave a hidden desktop behind.
#[cfg(windows)]
struct ProcessTree(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl ProcessTree {
    fn adopt(child: &std::process::Child) -> Result<Self, String> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        let failed = |step: &str| format!("cannot {step}: {}", std::io::Error::last_os_error());
        // SAFETY: plain Win32 calls on a handle this function owns and on the child's process
        // handle, which outlives the call; the limit structure is zeroed and then filled in.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(failed("create a job object"));
            }
            let tree = ProcessTree(job);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let set = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&limits).cast(),
                std::mem::size_of_val(&limits) as u32,
            );
            if set == 0 {
                return Err(failed("limit the job object"));
            }
            if AssignProcessToJobObject(job, child.as_raw_handle()) == 0 {
                return Err(failed("put the desktop in a job object"));
            }
            Ok(tree)
        }
    }

    /// False when the job could not be terminated; the caller then kills what it holds itself,
    /// or waiting for it would never end.
    fn terminate(&self) -> bool {
        // SAFETY: the handle is owned by `self` and still open.
        unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1) != 0 }
    }

    fn active_processes(&self) -> Result<u32, String> {
        use windows_sys::Win32::System::JobObjects::{
            JobObjectBasicAccountingInformation, QueryInformationJobObject,
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        };
        // SAFETY: the handle is owned by `self`; the buffer is a zeroed structure of the size passed.
        unsafe {
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
            let read = QueryInformationJobObject(
                self.0,
                JobObjectBasicAccountingInformation,
                std::ptr::from_mut(&mut info).cast(),
                std::mem::size_of_val(&info) as u32,
                std::ptr::null_mut(),
            );
            if read == 0 {
                return Err(format!("cannot read the job object: {}", std::io::Error::last_os_error()));
            }
            Ok(info.ActiveProcesses)
        }
    }

    fn wait_until_empty(&self, budget: std::time::Duration) -> Result<(), String> {
        let started = std::time::Instant::now();
        loop {
            let active = self.active_processes()?;
            if active == 0 {
                return Ok(());
            }
            if started.elapsed() >= budget {
                return Err(format!("{active} of the desktop's processes were still running {budget:?} after being terminated"));
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }
}

#[cfg(windows)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        // SAFETY: the handle is owned by `self` and closed only here.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

/// The browsers' Native Messaging registrations that point into `data_dir`. A desktop under
/// test must leave them alone: they are one per user, so re-pointing them at a directory the
/// test is about to delete cuts the installed app off from the browser.
#[cfg(windows)]
fn registrations_into(data_dir: &std::path::Path) -> Result<Vec<String>, String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    // The directory name is unique to this run; matching on it is indifferent to how the
    // desktop spelled the path.
    let name = data_dir.file_name().unwrap().to_string_lossy().to_lowercase();
    let mut found = Vec::new();
    for key in [
        r"Software\Google\Chrome\NativeMessagingHosts\com.resumepro.desktop",
        r"Software\Microsoft\Edge\NativeMessagingHosts\com.resumepro.desktop",
    ] {
        let value = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(key)
            .and_then(|handle| handle.get_value::<String, _>(""));
        let value = match value {
            Ok(value) => value,
            // No key, or a key without a value: nothing is registered there.
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => return Err(format!(r"cannot read HKCU\{key}: {err}")),
        };
        if value.to_lowercase().contains(&name) {
            found.push(format!(r"HKCU\{key} = {value}"));
        }
    }
    Ok(found)
}

#[cfg(windows)]
#[test]
#[cfg_attr(not(debug_assertions), ignore = "release builds cannot keep the desktop off the Native Messaging registration")]
fn a_hidden_start_opens_the_archive_before_webview2_starts() {
    // A hidden start is for the browser, which needs the archive and the endpoint, not the
    // window. WebView2 can take many seconds to start, longer than the host waits, so the
    // archive must not wait for it. Creation times make this independent of how fast either is.
    let tmp = paired_dir("archive-before-webview");
    let mut application = HiddenApplication::start(&tmp);
    application.wait_for_archive();
    let profile = tmp.join("cache").join("webview").join("EBWebView");
    application.wait_for("WebView2 creating its profile", || profile.exists().then_some(()));
    let created = |path: &std::path::Path| std::fs::metadata(path).and_then(|m| m.created()).unwrap();
    let (archive, webview) = (created(&tmp.join("current.json")), created(&profile));
    assert!(
        archive < webview,
        "the archive was opened {:?} after WebView2 started",
        archive.duration_since(webview).unwrap_or_default()
    );
    // Also fails the test if the desktop re-pointed the browser's registration.
    drop(application);
}

#[cfg(windows)]
#[test]
#[cfg_attr(not(debug_assertions), ignore = "release builds cannot keep the desktop off the Native Messaging registration")]
fn v2_resume_read_round_trips_through_the_real_host_and_application() {
    let tmp = paired_dir("v2-real-app");
    let mut application = HiddenApplication::start(&tmp);
    let current = application.wait_for_archive();
    let request = serde_json::json!({
        "protocolVersion": 2,
        "messageId": "33333333-3333-4333-8333-333333333333",
        "clientInstanceId": "11111111-1111-4111-8111-111111111111",
        "messageType": "resume.read",
        "occurredAt": "2026-09-24T00:00:00.000Z",
        "archiveId": current["archive_id"],
        "restoreEpoch": current["restore_epoch"],
        "payload": {}
    });
    let send = |request: &serde_json::Value| -> serde_json::Value {
        let (code, stdout, stderr) = run_host_with_data_dir(&[ORIGIN], &tmp, framed(&request.to_string()));
        assert_eq!(code, 0, "{stderr}");
        assert!(stdout.len() > 4, "host did not answer: {stderr}");
        let declared = u32::from_ne_bytes(stdout[..4].try_into().unwrap()) as usize;
        assert_eq!(stdout.len(), declared + 4);
        serde_json::from_slice(&stdout[4..]).unwrap()
    };
    let reply = send(&request);
    assert_eq!(reply["protocolVersion"], 2);
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(reply["payload"]["templates"], serde_json::json!([]));
    assert_eq!(reply["payload"]["profileRevision"], 0);
    let validated = resume_pro_protocol::validate_request_bytes(&serde_json::to_vec(&request).unwrap()).unwrap();
    resume_pro_protocol::validate_response_for_request(&reply, &validated).unwrap();

    let mut update = request.clone();
    update["messageId"] = serde_json::json!("44444444-4444-4444-8444-444444444444");
    update["messageType"] = serde_json::json!("resume.update");
    update["payload"] = serde_json::json!({
        "op":"saveProfile",
        "profile":{"values":{"fullName":"Alice"},"family":[],"custom":[]},
        "expectedRevision":0
    });
    let updated = send(&update);
    assert_eq!(updated["ok"], true, "{updated}");
    assert_eq!(updated["payload"]["profileRevision"], 1);
    let validated = resume_pro_protocol::validate_request_bytes(&serde_json::to_vec(&update).unwrap()).unwrap();
    resume_pro_protocol::validate_response_for_request(&updated, &validated).unwrap();

    let mut manifest = request.clone();
    manifest["messageId"] = serde_json::json!("55555555-5555-4555-8555-555555555555");
    manifest["messageType"] = serde_json::json!("legacy.import");
    manifest["payload"] = serde_json::json!({
        "importId":"77777777-7777-4777-8777-777777777777",
        "kind":"manifest","index":0,
        "body":{"pluginVersion":"0.4.0","total":1,"parts":[
            {"index":1,"kind":"template","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        ]}
    });
    let staged = send(&manifest);
    assert_eq!(staged["ok"], true, "{staged}");
    assert_eq!(staged["payload"]["state"], "receiving");
    let validated = resume_pro_protocol::validate_request_bytes(&serde_json::to_vec(&manifest).unwrap()).unwrap();
    resume_pro_protocol::validate_response_for_request(&staged, &validated).unwrap();
    drop(application);
}

/// A host under test and the desktop it cold-starts, all in one job. Dropping it stops them
/// and checks what they left, the way `HiddenApplication` does.
#[cfg(windows)]
struct ColdStart {
    host: std::process::Child,
    processes: ProcessTree,
    data_dir: std::path::PathBuf,
    _turn: std::sync::MutexGuard<'static, ()>,
}

#[cfg(windows)]
impl ColdStart {
    /// Start a host on `data_dir` with its stdio piped. Nothing is sent yet, so the host has
    /// started nothing before it is in the job.
    fn host(data_dir: &std::path::Path) -> Self {
        let turn = ONE_DESKTOP_AT_A_TIME.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut host = Command::new(env!("CARGO_BIN_EXE_resume-pro-desktop"))
            .arg(ORIGIN)
            .env("RESUMEPRO_DATA_DIR", data_dir)
            .env(SKIP_NM_REGISTRATION.0, SKIP_NM_REGISTRATION.1)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("the host must start");
        let processes = match ProcessTree::adopt(&host) {
            Ok(processes) => processes,
            Err(problem) => {
                let _ = host.kill();
                let _ = host.wait();
                panic!("{problem}");
            }
        };
        ColdStart { host, processes, data_dir: data_dir.to_path_buf(), _turn: turn }
    }

    /// Wait for the host to start the desktop and take hold of it: the host's child running
    /// this same executable. A console the host had to create would also be its child, as
    /// conhost.exe.
    fn desktop(&mut self, stderr_so_far: impl Fn() -> String) -> OpenedProcess {
        let program = std::path::Path::new(env!("CARGO_BIN_EXE_resume-pro-desktop"))
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_lowercase();
        let started = std::time::Instant::now();
        loop {
            // Checked before looking, so a host that exits right after starting the desktop is
            // still caught with it. Its `Child` keeps the host's id from passing to another process.
            let exited = self.host.try_wait().expect("the host can be polled");
            let desktop = process_snapshot()
                .into_iter()
                .filter(|p| p.parent == self.host.id() && p.name == program)
                .find_map(|p| OpenedProcess::open(p.pid));
            if let Some(desktop) = desktop {
                return desktop;
            }
            if let Some(status) = exited {
                panic!("the host exited ({status}) without starting the desktop\n{}", stderr_so_far());
            }
            if started.elapsed() >= HIDDEN_DESKTOP_STARTUP_BUDGET {
                panic!("the host had not started the desktop after {HIDDEN_DESKTOP_STARTUP_BUDGET:?}");
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
}

#[cfg(windows)]
impl Drop for ColdStart {
    fn drop(&mut self) {
        let mut problems = Vec::new();
        // As in HiddenApplication: without the job, at least the host must not keep this waiting.
        if !self.processes.terminate() {
            problems.push(format!("cannot terminate the host's job object: {}", std::io::Error::last_os_error()));
            let _ = self.host.kill();
        }
        let _ = self.host.wait();
        if let Err(problem) = self.processes.wait_until_empty(std::time::Duration::from_secs(10)) {
            problems.push(problem);
        }
        match registrations_into(&self.data_dir) {
            Ok(found) if found.is_empty() => {}
            Ok(found) => problems.push(format!(
                "the cold-started desktop re-pointed the browser at its temporary data directory: {}",
                found.join("; ")
            )),
            Err(problem) => problems.push(problem),
        }
        if problems.is_empty() {
            return;
        }
        let message = problems.join("\n");
        if std::thread::panicking() {
            eprintln!("{message}");
        } else {
            panic!("{message}");
        }
    }
}

/// A process opened so that it can be checked on. Holding it open keeps its id from passing to
/// another process.
#[cfg(windows)]
struct OpenedProcess(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl OpenedProcess {
    fn open(pid: u32) -> Option<Self> {
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        };
        // SAFETY: a plain Win32 call; a null handle is checked for below.
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, 0, pid) };
        (!handle.is_null()).then_some(OpenedProcess(handle))
    }

    fn is_running(&self) -> bool {
        use windows_sys::Win32::Foundation::WAIT_TIMEOUT;
        use windows_sys::Win32::System::Threading::WaitForSingleObject;
        // SAFETY: the handle is owned by `self` and still open.
        unsafe { WaitForSingleObject(self.0, 0) == WAIT_TIMEOUT }
    }

    fn exit_code(&self) -> Option<u32> {
        use windows_sys::Win32::System::Threading::GetExitCodeProcess;
        let mut code = 0;
        // SAFETY: the handle is owned by `self` and still open; `code` outlives the call.
        (unsafe { GetExitCodeProcess(self.0, &mut code) } != 0).then_some(code)
    }
}

#[cfg(windows)]
impl Drop for OpenedProcess {
    fn drop(&mut self) {
        // SAFETY: the handle is owned by `self` and closed only here.
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}

#[cfg(windows)]
struct ProcessEntry {
    pid: u32,
    parent: u32,
    /// The executable's file name, in lower case.
    name: String,
}

/// The processes running right now.
#[cfg(windows)]
fn process_snapshot() -> Vec<ProcessEntry> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    let mut found = Vec::new();
    // SAFETY: plain Win32 calls on a snapshot handle this function owns and closes; the entry
    // is zeroed with its size filled in, as Process32FirstW requires.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return found;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut more = Process32FirstW(snapshot, &mut entry) != 0;
        while more {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            found.push(ProcessEntry {
                pid: entry.th32ProcessID,
                parent: entry.th32ParentProcessID,
                name: String::from_utf16_lossy(&entry.szExeFile[..len]).to_lowercase(),
            });
            more = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
    }
    found
}

/// Read `pipe` to end of file on a thread of its own. The receiver gets what it held once it
/// ends; the shared buffer shows what has arrived so far.
#[cfg(windows)]
fn read_to_end_in_background(
    mut pipe: impl std::io::Read + Send + 'static,
) -> (std::sync::mpsc::Receiver<Vec<u8>>, std::sync::Arc<std::sync::Mutex<Vec<u8>>>) {
    let (done, ended) = std::sync::mpsc::channel();
    let so_far = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = so_far.clone();
    std::thread::spawn(move || {
        let mut chunk = [0u8; 4096];
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => sink.lock().unwrap().extend_from_slice(&chunk[..n]),
            }
        }
        let _ = done.send(sink.lock().unwrap().clone());
    });
    (ended, so_far)
}

#[cfg(windows)]
#[test]
#[cfg_attr(not(debug_assertions), ignore = "release builds cannot keep the desktop off the Native Messaging registration")]
fn a_desktop_the_host_starts_does_not_hold_the_browsers_pipes_open() {
    // The browser talks to the host over the host's stdin and stdout, and learns the host is
    // gone when stdout reaches end of file. A test runner such as Playwright also gives the
    // browser a stderr pipe, which the host inherits, and waits for that pipe to end. The
    // desktop a host cold-starts outlives the host on purpose. If it inherited the host's
    // handles, neither pipe would end until the desktop quit.
    let tmp = paired_dir("cold-start-pipes");
    let mut cold_start = ColdStart::host(&tmp);
    let (stdout_ended, _) = read_to_end_in_background(cold_start.host.stdout.take().unwrap());
    let (stderr_ended, stderr_so_far) = read_to_end_in_background(cold_start.host.stderr.take().unwrap());
    let stderr_text = || String::from_utf8_lossy(&stderr_so_far.lock().unwrap()).into_owned();
    // One message, then the port closes: the host forwards it, which needs the desktop, and
    // exits once it has answered.
    let mut stdin = cold_start.host.stdin.take().unwrap();
    stdin.write_all(&framed(HANDSHAKE)).unwrap();
    drop(stdin);
    let desktop = cold_start.desktop(&stderr_text);

    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = cold_start.host.try_wait().expect("the host can be polled") {
            break status;
        }
        assert!(
            started.elapsed() < HIDDEN_DESKTOP_STARTUP_BUDGET,
            "the host did not exit after its port closed\n{}",
            stderr_text()
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    };
    assert!(status.success(), "the host failed ({status})\n{}", stderr_text());

    let grace = std::time::Duration::from_secs(5);
    let stdout = stdout_ended.recv_timeout(grace);
    let stderr = stderr_ended.recv_timeout(grace);
    // Without a running desktop there is nothing left that could hold the pipes, and the
    // checks below would pass whatever the host passed on. A desktop that exits 0 this early
    // has usually handed its launch to another running instance of the same application.
    assert!(
        desktop.is_running(),
        "the desktop must still be running for this to mean anything; it exited with {:?}, current.json written: {}\n{}",
        desktop.exit_code(),
        tmp.join("current.json").exists(),
        stderr_text()
    );
    let stdout = stdout.expect("the host's stdout did not end after the host exited: the desktop it started still holds it");
    stderr.expect("the host's stderr did not end after the host exited: the desktop it started still holds it");
    // The handshake reached the desktop, or at least the host's wait for it, and was answered.
    assert!(stdout.len() > 4, "the host did not answer\n{}", stderr_text());
    let declared = u32::from_ne_bytes(stdout[..4].try_into().unwrap()) as usize;
    assert_eq!(stdout.len(), 4 + declared, "stdout must be exactly one frame");
    // Stops the desktop and WebView2, and fails the test if the desktop re-pointed the browser.
    drop(cold_start);
}
