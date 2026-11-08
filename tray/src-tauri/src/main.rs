// The Tabula tray app: an icon next to the clock that starts, stops and watches tabula worker.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running the Tabula tray");
}
