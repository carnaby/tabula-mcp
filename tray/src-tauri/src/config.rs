//! Where the tray finds Node.js and the tabula command: `<data>/tray.json`, optional. `<data>` is the worker's data
//! folder, the same as the CLI's (`dataHome` in cli/tabula.mjs); the worker writes worker.log there.

use std::path::{Path, PathBuf};

use serde::Deserialize;

/// The tray's folders: the data folder and the folder `tabula install` puts the CLI in (~/.tabula).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Paths {
    pub data: PathBuf,
    pub tabula_home: PathBuf,
}

impl Paths {
    /// From the environment, like the CLI: TABULA_DATA_DIR, LOCALAPPDATA or XDG_DATA_HOME, and TABULA_HOME.
    pub fn from_env() -> Self {
        let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let windows = cfg!(windows);
        let home = PathBuf::from(env(if windows { "USERPROFILE" } else { "HOME" }).unwrap_or_default());
        Paths {
            data: data_home(&env, windows, &home),
            tabula_home: env("TABULA_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".tabula")),
        }
    }

    pub fn tray_json(&self) -> PathBuf {
        self.data.join("tray.json")
    }
}

/// %LOCALAPPDATA%\tabula on Windows, $XDG_DATA_HOME/tabula (~/.local/share/tabula) elsewhere; TABULA_DATA_DIR wins.
pub fn data_home(env: &dyn Fn(&str) -> Option<String>, windows: bool, home: &Path) -> PathBuf {
    if let Some(dir) = env("TABULA_DATA_DIR") {
        return PathBuf::from(dir);
    }
    if windows {
        return env("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| home.join("AppData").join("Local")).join("tabula");
    }
    env("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".local").join("share")).join("tabula")
}

/// The programs the tray runs, and the file they come from (named in messages).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrayConfig {
    pub node: PathBuf,
    pub cli: PathBuf,
    pub file: PathBuf,
}

/// tray.json as written; an unknown key is refused, so a typo does not pass unnoticed.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    node: Option<String>,
    cli: Option<String>,
}

/// The settings in `<data>/tray.json`. No file, or a blank value, means `node` from PATH and `<tabula home>/tabula.mjs`.
pub fn load(paths: &Paths) -> Result<TrayConfig, String> {
    let file = paths.tray_json();
    let parsed = match std::fs::read_to_string(&file) {
        Ok(text) => serde_json::from_str::<File>(text.trim_start_matches('\u{feff}'))
            .map_err(|e| format!("{} is not valid: {e}", file.display()))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => File { node: None, cli: None },
        // PowerShell 5.1 writes UTF-16 with `>` and Out-File.
        Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {
            return Err(format!("cannot read {}: {e}; save it as UTF-8", file.display()));
        }
        Err(e) => return Err(format!("cannot read {}: {e}", file.display())),
    };
    let set = |v: Option<String>| v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).map(PathBuf::from);
    Ok(TrayConfig {
        node: set(parsed.node).unwrap_or_else(|| PathBuf::from("node")),
        cli: set(parsed.cli).unwrap_or_else(|| paths.tabula_home.join("tabula.mjs")),
        file,
    })
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    /// A fresh folder whose name has a space and a diacritic.
    fn temp() -> PathBuf {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!("tabula tray config é {}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn paths(dir: &Path) -> Paths {
        Paths { data: dir.join("data"), tabula_home: dir.join(".tabula") }
    }

    fn write(p: &Paths, text: &str) {
        fs::create_dir_all(&p.data).unwrap();
        fs::write(p.tray_json(), text).unwrap();
    }

    #[test]
    fn finds_the_data_folder_like_the_cli() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string())
        };
        let home = Path::new("H");
        assert_eq!(data_home(&env(&[("TABULA_DATA_DIR", "X")]), true, home), PathBuf::from("X"));
        assert_eq!(data_home(&env(&[("LOCALAPPDATA", "L")]), true, home), Path::new("L").join("tabula"));
        assert_eq!(data_home(&env(&[]), true, home), home.join("AppData").join("Local").join("tabula"));
        assert_eq!(data_home(&env(&[("XDG_DATA_HOME", "D")]), false, home), Path::new("D").join("tabula"));
        assert_eq!(data_home(&env(&[]), false, home), home.join(".local").join("share").join("tabula"));
    }

    #[test]
    fn without_tray_json_runs_node_from_path_and_the_installed_cli() {
        let dir = temp();
        assert_eq!(
            load(&paths(&dir)),
            Ok(TrayConfig {
                node: PathBuf::from("node"),
                cli: dir.join(".tabula").join("tabula.mjs"),
                file: dir.join("data").join("tray.json"),
            })
        );
    }

    #[test]
    fn reads_node_and_cli_from_tray_json_even_with_a_bom() {
        let dir = temp();
        let p = paths(&dir);
        let node = dir.join("Program Files").join("nodejs").join("node.exe");
        let cli = dir.join("Ján Novák").join(".tabula").join("tabula.mjs");
        let json = serde_json::json!({ "node": &node, "cli": &cli }).to_string();
        // PowerShell 5.1 writes UTF-8 with a byte-order mark.
        write(&p, &format!("\u{feff}{json}"));
        let cfg = load(&p).unwrap();
        assert_eq!((cfg.node, cfg.cli), (node, cli));
    }

    #[test]
    fn blank_values_mean_the_defaults() {
        let dir = temp();
        let p = paths(&dir);
        write(&p, r#"{ "node": " ", "cli": "" }"#);
        let cfg = load(&p).unwrap();
        assert_eq!((cfg.node, cfg.cli), (PathBuf::from("node"), dir.join(".tabula").join("tabula.mjs")));
    }

    #[test]
    fn refuses_broken_json_and_unknown_keys() {
        let dir = temp();
        let p = paths(&dir);
        write(&p, "{ node: ");
        assert!(load(&p).unwrap_err().contains("tray.json is not valid"));
        write(&p, r#"{ "nodePath": "node" }"#);
        assert!(load(&p).unwrap_err().contains("unknown field `nodePath`"));
    }

    #[test]
    fn says_to_save_a_utf16_tray_json_as_utf8() {
        let dir = temp();
        let p = paths(&dir);
        fs::create_dir_all(&p.data).unwrap();
        // What PowerShell 5.1 `>` and Out-File write: UTF-16 LE with a byte-order mark.
        let utf16: Vec<u8> = [0xFF, 0xFE].into_iter().chain(r#"{ "node": "node" }"#.encode_utf16().flat_map(u16::to_le_bytes)).collect();
        fs::write(p.tray_json(), utf16).unwrap();
        let message = load(&p).unwrap_err();
        assert!(message.contains("cannot read") && message.contains("tray.json") && message.contains("save it as UTF-8"), "{message}");
    }
}
