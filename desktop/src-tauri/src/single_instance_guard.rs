//! Closes a startup race in tauri-plugin-single-instance 2.4 on Windows.
//!
//! The plugin creates a named mutex and then a hidden message window that later launches send
//! their arguments to. A process that opens the mutex while the first one has not made that window
//! yet does not exit: it carries on as a first instance, without a window of its own. When several
//! browser hosts cold-start the application at once, that process can then win `host.lock`. The
//! instance that owned the window gives up and exits, and nothing can reach the one that stays:
//! every later `--quit` starts as a new first instance, quits itself and exits 0, while the real
//! one keeps running.
//!
//! Plugin 2.5.5 fixes this by waiting up to a second for the window and exiting if it never
//! appears, but it needs Tauri 2.12. Until then the application does the same around the plugin:
//! [`wait_for_running`] before the plugin runs, so a launch is handed to the running instance, and
//! [`fell_through`] after it, so a process that still got through never takes `host.lock`.
//!
//! The names are the plugin's own (`{identifier}-sim`, `-sic`, `-siw`, unchanged up to 2.5.5,
//! without its `semver` feature). If they ever change, both checks find no mutex and step aside,
//! which leaves the plugin's own behaviour rather than stopping the application from starting.

use std::time::{Duration, Instant};

/// As long as plugin 2.5.5 waits for the window before giving up.
pub const WINDOW_WAIT: Duration = Duration::from_secs(1);
const POLL: Duration = Duration::from_millis(25);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Running {
    /// No other instance holds the mutex, so this process may become the first.
    None,
    /// Another instance's message window exists, so the plugin will hand this launch to it.
    Reachable,
    /// Another instance holds the mutex but showed no message window within the wait.
    Unreachable,
}

/// Wait until another instance can be reached, or there is none.
pub fn wait_for_running(identifier: &str, budget: Duration) -> Running {
    let names = imp::Names::new(identifier);
    let started = Instant::now();
    loop {
        if !imp::mutex_exists(&names) {
            return Running::None;
        }
        if !imp::window_owners(&names).is_empty() {
            return Running::Reachable;
        }
        if started.elapsed() >= budget {
            return Running::Unreachable;
        }
        std::thread::sleep(POLL);
    }
}

/// After the plugin has run: the mutex exists but the message window is not this process's.
///
/// The plugin made the first instance's window right after its mutex, so this process is a
/// second one that the plugin let through. Without its own window nothing could reach it.
pub fn fell_through(identifier: &str) -> bool {
    let names = imp::Names::new(identifier);
    imp::mutex_exists(&names) && !imp::window_owners(&names).contains(&std::process::id())
}

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenMutexW, SYNCHRONIZATION_SYNCHRONIZE};
    use windows_sys::Win32::UI::WindowsAndMessaging::{FindWindowExW, GetWindowThreadProcessId};

    pub struct Names {
        pub mutex: Vec<u16>,
        pub class: Vec<u16>,
        pub window: Vec<u16>,
    }

    impl Names {
        pub fn new(identifier: &str) -> Self {
            Self {
                mutex: wide(&format!("{identifier}-sim")),
                class: wide(&format!("{identifier}-sic")),
                window: wide(&format!("{identifier}-siw")),
            }
        }
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }

    pub fn mutex_exists(names: &Names) -> bool {
        // Open, never create: creating it here would make this process look like the first one.
        // SAFETY: the name is NUL-terminated and outlives the call.
        let handle = unsafe { OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, 0, names.mutex.as_ptr()) };
        if handle.is_null() {
            return false;
        }
        // SAFETY: closing the handle opened just above.
        unsafe { CloseHandle(handle) };
        true
    }

    /// The processes that own a top-level window with the plugin's class and title.
    pub fn window_owners(names: &Names) -> Vec<u32> {
        let mut owners = Vec::new();
        let mut after = std::ptr::null_mut();
        loop {
            // SAFETY: both strings are NUL-terminated; `after` is null or a window found before.
            let window = unsafe {
                FindWindowExW(std::ptr::null_mut(), after, names.class.as_ptr(), names.window.as_ptr())
            };
            if window.is_null() {
                return owners;
            }
            let mut process = 0;
            // SAFETY: `process` is a valid out pointer; a window that is already gone yields 0.
            unsafe { GetWindowThreadProcessId(window, &mut process) };
            owners.push(process);
            after = window;
        }
    }
}

#[cfg(not(windows))]
mod imp {
    //! The race is in the plugin's Windows implementation; elsewhere the plugin is trusted.

    pub struct Names;

    impl Names {
        pub fn new(_identifier: &str) -> Self {
            Self
        }
    }

    pub fn mutex_exists(_names: &Names) -> bool {
        false
    }

    pub fn window_owners(_names: &Names) -> Vec<u32> {
        Vec::new()
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Threading::{CreateMutexW, ReleaseMutex};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassExW, UnregisterClassW,
        WNDCLASSEXW, WS_OVERLAPPED,
    };

    fn identifier() -> String {
        format!("resume-pro-single-instance-test-{}", uuid::Uuid::new_v4())
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }

    /// The running instance's mutex, as the plugin creates it.
    struct Mutex(HANDLE);

    impl Mutex {
        fn hold(identifier: &str) -> Self {
            let name = wide(&format!("{identifier}-sim"));
            // SAFETY: the name is NUL-terminated and outlives the call.
            let handle = unsafe { CreateMutexW(std::ptr::null(), 1, name.as_ptr()) };
            assert!(!handle.is_null(), "test mutex could not be created");
            Self(handle)
        }
    }

    impl Drop for Mutex {
        fn drop(&mut self) {
            // SAFETY: releasing and closing the handle this value owns.
            unsafe {
                ReleaseMutex(self.0);
                CloseHandle(self.0);
            }
        }
    }

    unsafe extern "system" fn window_proc(window: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        DefWindowProcW(window, message, wparam, lparam)
    }

    /// The running instance's message window, made after `delay` on a thread of its own and
    /// destroyed on that thread when the value is dropped.
    struct MessageWindow {
        stop: mpsc::Sender<()>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl MessageWindow {
        fn after(identifier: &str, delay: Duration) -> Self {
            let class = wide(&format!("{identifier}-sic"));
            let title = wide(&format!("{identifier}-siw"));
            let (stop, stopped) = mpsc::channel();
            let thread = std::thread::spawn(move || {
                std::thread::sleep(delay);
                // SAFETY: plain window class registration and creation with NUL-terminated names
                // that outlive the window; the window is destroyed on this thread before return.
                unsafe {
                    let instance = GetModuleHandleW(std::ptr::null());
                    let mut definition: WNDCLASSEXW = std::mem::zeroed();
                    definition.cbSize = std::mem::size_of::<WNDCLASSEXW>() as u32;
                    definition.lpfnWndProc = Some(window_proc);
                    definition.hInstance = instance;
                    definition.lpszClassName = class.as_ptr();
                    assert_ne!(RegisterClassExW(&definition), 0, "test window class");
                    let window = CreateWindowExW(
                        0,
                        class.as_ptr(),
                        title.as_ptr(),
                        WS_OVERLAPPED,
                        0,
                        0,
                        0,
                        0,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        instance,
                        std::ptr::null(),
                    );
                    assert!(!window.is_null(), "test window");
                    let _ = stopped.recv();
                    DestroyWindow(window);
                    UnregisterClassW(class.as_ptr(), instance);
                }
            });
            Self { stop, thread: Some(thread) }
        }
    }

    impl Drop for MessageWindow {
        fn drop(&mut self) {
            let _ = self.stop.send(());
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    #[test]
    fn with_no_other_instance_the_launch_goes_ahead_at_once() {
        let id = identifier();
        let started = Instant::now();
        assert_eq!(wait_for_running(&id, Duration::from_secs(5)), Running::None);
        assert!(started.elapsed() < Duration::from_secs(2));
        // Also what a renamed plugin mutex looks like: no judgement, the plugin decides.
        assert!(!fell_through(&id));
    }

    #[test]
    fn a_window_made_during_the_wait_is_found_and_the_wait_ends() {
        // The race: the mutex exists, the window comes a moment later.
        let id = identifier();
        let _mutex = Mutex::hold(&id);
        let _window = MessageWindow::after(&id, Duration::from_millis(150));
        let started = Instant::now();
        assert_eq!(wait_for_running(&id, Duration::from_secs(10)), Running::Reachable);
        assert!(started.elapsed() < Duration::from_secs(5), "it must not run out the budget");
    }

    #[test]
    fn a_mutex_whose_window_never_comes_is_unreachable_once_the_budget_runs_out() {
        let id = identifier();
        let _mutex = Mutex::hold(&id);
        let started = Instant::now();
        assert_eq!(wait_for_running(&id, Duration::from_millis(200)), Running::Unreachable);
        assert!(started.elapsed() >= Duration::from_millis(200));
    }

    #[test]
    fn an_instance_that_exits_during_the_wait_leaves_the_way_free() {
        let id = identifier();
        let (held, is_held) = mpsc::channel();
        let release = {
            let id = id.clone();
            // A mutex is owned by the thread that created it, so it is released there too.
            std::thread::spawn(move || {
                let _mutex = Mutex::hold(&id);
                held.send(()).unwrap();
                std::thread::sleep(Duration::from_millis(150));
            })
        };
        is_held.recv().unwrap();
        let started = Instant::now();
        assert_eq!(wait_for_running(&id, Duration::from_secs(10)), Running::None);
        assert!(started.elapsed() < Duration::from_secs(5));
        release.join().unwrap();
    }

    #[test]
    fn a_process_with_the_mutex_but_no_window_of_its_own_fell_through() {
        let id = identifier();
        let _mutex = Mutex::hold(&id);
        assert!(fell_through(&id), "the plugin let it through without a window");
        // The first instance: the plugin made its window right after the mutex.
        let _window = MessageWindow::after(&id, Duration::ZERO);
        let started = Instant::now();
        while fell_through(&id) {
            assert!(started.elapsed() < Duration::from_secs(5), "the window was never found");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
