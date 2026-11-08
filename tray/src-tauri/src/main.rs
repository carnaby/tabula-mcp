// The Tabula tray app: an icon next to the clock that starts, stops and watches tabula worker.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Arc;

use tabula_tray_lib::config::Paths;
use tabula_tray_lib::controller::{Controller, Timing};
use tabula_tray_lib::state::{is_web_url, Input, Snapshot};
use tabula_tray_lib::tray::{show_window, TrayUi};
use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_notification::NotificationExt as _;
use tauri_plugin_opener::OpenerExt as _;

/// What the start at sign-in passes: the tray then starts without its window.
const BACKGROUND: &str = "--background";

#[tauri::command]
fn snapshot(ctl: State<'_, Controller>) -> Snapshot {
    ctl.snapshot()
}

#[tauri::command]
fn start(once: bool, ctl: State<'_, Controller>) {
    ctl.send(Input::Start { once });
}

#[tauri::command]
fn stop(ctl: State<'_, Controller>) {
    ctl.send(Input::Stop);
}

#[tauri::command]
fn run_doctor(ctl: State<'_, Controller>) {
    ctl.send(Input::Doctor);
}

/// The current job's report in the browser.
#[tauri::command]
fn open_report(app: AppHandle, ctl: State<'_, Controller>) -> Result<(), String> {
    let Some(job) = ctl.snapshot().job else { return Ok(()) };
    if !is_web_url(&job.report_url) {
        return Err(format!("not a web address: {}", job.report_url));
    }
    app.opener().open_url(job.report_url, None::<&str>).map_err(|e| e.to_string())
}

/// The data folder with worker.log (and tray.json).
#[tauri::command]
fn open_log_folder(app: AppHandle, paths: State<'_, Paths>) -> Result<(), String> {
    std::fs::create_dir_all(&paths.data).map_err(|e| e.to_string())?;
    app.opener().open_path(paths.data.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

fn main() {
    let paths = Paths::from_env();
    tauri::Builder::default()
        // First: a second start of the tray only opens the window of the running one.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_window(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![BACKGROUND])))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(paths.clone())
        .invoke_handler(tauri::generate_handler![snapshot, start, stop, run_doctor, open_report, open_log_folder])
        .setup(move |app| {
            let handle = app.handle().clone();
            // A click on the notification opens the window (Windows reports it while the toast is on screen). Set up
            // before the controller starts: a notification shown before any handler existed reports nothing.
            let shown = handle.clone();
            app.notification().on_action(move |action| {
                if action.action_id() == "tap" {
                    show_window(&shown);
                }
            })?;
            let ui = Arc::new(TrayUi::build(&handle)?);
            app.manage(Controller::start(paths, ui, Timing::default()));
            if !std::env::args().any(|a| a == BACKGROUND) {
                show_window(&handle);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window only hides it; the tray keeps running.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the Tabula tray")
        .run(|_app, event| {
            // Only Quit ends the tray (it exits with a code); nothing else may, such as the last window closing.
            if let RunEvent::ExitRequested { code: None, api, .. } = event {
                api.prevent_exit();
            }
        });
}
