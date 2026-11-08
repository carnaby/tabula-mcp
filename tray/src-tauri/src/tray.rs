//! The tray icon, its menu and notifications: how the controller's snapshots look on the desktop.

use std::sync::{Mutex, MutexGuard, PoisonError};

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_notification::NotificationExt as _;

use crate::controller::{Controller, Ui};
use crate::state::{Icon, Input, Snapshot};

/// The label of the window in tauri.conf.json.
pub const WINDOW: &str = "main";

pub fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Whether the taskbar is light: Windows says so in the registry; other panels get the icons for a dark one.
#[cfg(windows)]
pub fn panel_is_light() -> bool {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let key = wide(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
    let name = wide("SystemUsesLightTheme");
    let mut value: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    // SAFETY: both names are NUL-terminated UTF-16; `value` and `size` describe a writable u32.
    let status = unsafe {
        RegGetValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr(), RRF_RT_REG_DWORD, std::ptr::null_mut(), (&mut value as *mut u32).cast(), &mut size)
    };
    status == 0 && value == 1
}

#[cfg(not(windows))]
pub fn panel_is_light() -> bool {
    false
}

/// The PNGs scripts/icons.mjs made from icons/tray.svg; "light" ones are for a light taskbar.
fn icon_png(icon: Icon, light: bool) -> &'static [u8] {
    match (icon, light) {
        (Icon::Stopped, true) => include_bytes!("../icons/tray/stopped-light.png"),
        (Icon::Stopped, false) => include_bytes!("../icons/tray/stopped-dark.png"),
        (Icon::Waiting, true) => include_bytes!("../icons/tray/waiting-light.png"),
        (Icon::Waiting, false) => include_bytes!("../icons/tray/waiting-dark.png"),
        (Icon::Idle, true) => include_bytes!("../icons/tray/idle-light.png"),
        (Icon::Idle, false) => include_bytes!("../icons/tray/idle-dark.png"),
        (Icon::Busy, true) => include_bytes!("../icons/tray/busy-light.png"),
        (Icon::Busy, false) => include_bytes!("../icons/tray/busy-dark.png"),
        (Icon::Error, true) => include_bytes!("../icons/tray/error-light.png"),
        (Icon::Error, false) => include_bytes!("../icons/tray/error-dark.png"),
    }
}

fn icon_image(icon: Icon, light: bool) -> tauri::Result<Image<'static>> {
    Image::from_bytes(icon_png(icon, light))
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What the tray shows now, so a render changes only what differs.
#[derive(Default)]
struct Shown {
    icon: Option<(Icon, bool)>,
    tooltip: String,
    status: String,
    can_start: bool,
    can_stop: bool,
    stop_label: String,
}

pub struct TrayUi {
    app: AppHandle,
    tray: TrayIcon<Wry>,
    status: MenuItem<Wry>,
    process: MenuItem<Wry>,
    start: MenuItem<Wry>,
    stop: MenuItem<Wry>,
    shown: Mutex<Shown>,
}

impl TrayUi {
    /// The icon with its menu. Clicks become controller inputs (the controller is managed state, see main.rs).
    pub fn build(app: &AppHandle) -> tauri::Result<TrayUi> {
        let item = |id: &str, text: &str, enabled: bool| MenuItem::with_id(app, id, text, enabled, None::<&str>);
        let status = item("status", "Checking the queue…", false)?;
        let process = item("process", "Process queue", false)?;
        let start = item("start", "Start", false)?;
        let stop = item("stop", "Stop", false)?;
        let open = item("open", "Open window", true)?;
        let at_sign_in = app.autolaunch().is_enabled().unwrap_or(false);
        let autostart = CheckMenuItem::with_id(app, "autostart", "Start Tabula tray at sign-in", true, at_sign_in, None::<&str>)?;
        let quit = item("quit", "Quit", true)?;
        let menu = Menu::with_items(
            app,
            &[
                &status,
                &PredefinedMenuItem::separator(app)?,
                &process,
                &start,
                &stop,
                &PredefinedMenuItem::separator(app)?,
                &open,
                &autostart,
                &PredefinedMenuItem::separator(app)?,
                &quit,
            ],
        )?;
        let check = autostart.clone();
        let tray = TrayIconBuilder::with_id("tabula")
            .icon(icon_image(Icon::Stopped, panel_is_light())?)
            .tooltip("Tabula worker: stopped")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_menu_event(move |app, event| on_menu(app, &event, &check))
            .on_tray_icon_event(|tray, event| {
                // Linux reports no clicks on the icon: there "Open window" in the menu opens it.
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                    show_window(tray.app_handle());
                }
            })
            .build(app)?;
        Ok(TrayUi { app: app.clone(), tray, status, process, start, stop, shown: Mutex::new(Shown::default()) })
    }
}

fn on_menu(app: &AppHandle, event: &MenuEvent, autostart: &CheckMenuItem<Wry>) {
    let send = |input: Input| {
        if let Some(ctl) = app.try_state::<Controller>() {
            ctl.send(input);
        }
    };
    match event.id().as_ref() {
        "process" => send(Input::Start { once: true }),
        "start" => send(Input::Start { once: false }),
        "stop" => send(Input::Stop),
        "open" => show_window(app),
        "quit" => {
            // Without a controller to stop the worker first, exit at once: the worker stops when its input closes.
            if !app.try_state::<Controller>().is_some_and(|ctl| ctl.send(Input::Quit)) {
                app.exit(0);
            }
        }
        "autostart" => {
            let launcher = app.autolaunch();
            let on = launcher.is_enabled().unwrap_or(false);
            let _ = if on { launcher.disable() } else { launcher.enable() };
            // The item toggles itself on click; show what the system really has.
            let _ = autostart.set_checked(launcher.is_enabled().unwrap_or(on));
        }
        _ => {}
    }
}

impl Ui for TrayUi {
    fn render(&self, s: &Snapshot) {
        let light = panel_is_light();
        let mut shown = lock(&self.shown);
        if shown.icon != Some((s.icon, light)) {
            if let Ok(image) = icon_image(s.icon, light) {
                let _ = self.tray.set_icon(Some(image));
            }
            shown.icon = Some((s.icon, light));
        }
        if shown.tooltip != s.tooltip {
            let _ = self.tray.set_tooltip(Some(&s.tooltip));
            shown.tooltip = s.tooltip.clone();
        }
        if shown.status != s.status {
            let _ = self.status.set_text(&s.status);
            shown.status = s.status.clone();
        }
        if shown.can_start != s.can_start {
            let _ = self.process.set_enabled(s.can_start);
            let _ = self.start.set_enabled(s.can_start);
            shown.can_start = s.can_start;
        }
        if shown.can_stop != s.can_stop {
            let _ = self.stop.set_enabled(s.can_stop);
            shown.can_stop = s.can_stop;
        }
        if shown.stop_label != s.stop_label {
            let _ = self.stop.set_text(&s.stop_label);
            shown.stop_label = s.stop_label.clone();
        }
        drop(shown);
        let _ = self.app.emit("state", s);
    }

    fn notify(&self, queued: u32) {
        let body = if queued == 1 { "1 recording waiting".to_string() } else { format!("{queued} recordings waiting") };
        let _ = self.app.notification().builder().title("New recording to transcribe").body(body).show();
    }

    fn exit(&self) {
        self.app.exit(0);
    }
}
