//! The queue on the server, through `tabula worker queue --json`: the CLI holds the URL and the token, never the tray.

use std::io::Read;
use std::process::{Child, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::config::TrayConfig;
use crate::state::{QueueResult, OLD_CLI, OLD_CLI_SIGNS};
use crate::worker::{check_cli, command, kill_tree, spawn_error};

/// How long one check may take; the CLI itself gives up on the server after 15 s.
pub const QUEUE_TIMEOUT: Duration = Duration::from_secs(30);

/// How long the output is awaited once the process ended (a grandchild may hold a pipe open), and how long a killed
/// process is awaited.
const AFTER_EXIT: Duration = Duration::from_secs(2);

#[derive(Deserialize)]
struct Reply {
    ok: bool,
    queued: Option<u32>,
    running: Option<u32>,
    worker_last_seen: Option<String>,
    message: Option<String>,
}

/// The answer in what the CLI printed: its last JSON line, else what its stderr says.
pub fn parse_output(stdout: &str, stderr: &str) -> QueueResult {
    if let Some(line) = stdout.lines().rev().map(str::trim).find(|l| !l.is_empty()) {
        if let Ok(reply) = serde_json::from_str::<Reply>(line) {
            return match (reply.ok, reply.queued, reply.running) {
                (true, Some(queued), Some(running)) => QueueResult::Ok { queued, running, worker_last_seen: reply.worker_last_seen },
                _ => QueueResult::Failed {
                    message: reply.message.unwrap_or_else(|| "tabula worker queue reported an error without a message".to_string()),
                },
            };
        }
    }
    if OLD_CLI_SIGNS.iter().any(|sign| stderr.contains(sign)) {
        return QueueResult::Failed { message: OLD_CLI.to_string() };
    }
    let why = stderr.lines().rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or("it printed nothing");
    QueueResult::Failed { message: format!("tabula worker queue did not answer: {why}") }
}

/// All of `r` as text, on its own thread (so the CLI never waits for the tray to read).
fn read_all(r: Option<impl Read + Send + 'static>) -> Receiver<String> {
    let (tx, rx) = mpsc::channel();
    if let Some(mut r) = r {
        let _ = thread::Builder::new().name("tabula queue output".into()).spawn(move || {
            let mut bytes = Vec::new();
            let _ = r.read_to_end(&mut bytes);
            let _ = tx.send(String::from_utf8_lossy(&bytes).into_owned());
        });
    }
    rx
}

/// Wait at most `timeout` for the end of `child`. True when it ended.
fn wait_until(child: &mut Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            _ => return false,
        }
    }
}

/// Run `tabula worker queue --json`; one that takes longer than `timeout` is ended. Always returns, never panics:
/// every failure is a [`QueueResult::Failed`] with a message for the window.
pub fn check(cfg: &TrayConfig, timeout: Duration) -> QueueResult {
    if let Err(message) = check_cli(cfg) {
        return QueueResult::Failed { message };
    }
    let mut cmd = command(cfg, &["worker", "queue", "--json"]);
    cmd.stdin(Stdio::null());
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => return QueueResult::Failed { message: spawn_error(cfg, &e) },
    };
    let out = read_all(child.stdout.take());
    let err = read_all(child.stderr.take());
    if !wait_until(&mut child, timeout) {
        kill_tree(&mut child);
        wait_until(&mut child, AFTER_EXIT);
        return QueueResult::Failed { message: format!("tabula worker queue did not answer within {} s", timeout.as_secs()) };
    }
    let deadline = Instant::now() + AFTER_EXIT;
    let read = |rx: Receiver<String>| rx.recv_timeout(deadline.saturating_duration_since(Instant::now())).unwrap_or_default();
    parse_output(&read(out), &read(err))
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;
    use crate::worker::testing::fake_cli;

    #[test]
    fn reads_the_json_line_of_the_cli() {
        assert_eq!(
            parse_output("{\"ok\":true,\"server\":\"https://tabula.example.com\",\"queued\":2,\"running\":1,\"worker_last_seen\":\"2026-11-08T10:00:00.000Z\"}\n", ""),
            QueueResult::Ok { queued: 2, running: 1, worker_last_seen: Some("2026-11-08T10:00:00.000Z".into()) }
        );
        assert_eq!(
            parse_output(r#"{"ok":false,"error":"config","message":"no worker token: run tabula worker setup"}"#, ""),
            QueueResult::Failed { message: "no worker token: run tabula worker setup".into() }
        );
        assert_eq!(parse_output("", "tabula: unknown worker command \"queue\"; run tabula help\n"), QueueResult::Failed { message: OLD_CLI.into() });
        // What tabula 1.2.0 really answers to "worker queue --json" (and to "worker --events").
        assert_eq!(parse_output("", "tabula: tabula worker does not take --json\n"), QueueResult::Failed { message: OLD_CLI.into() });
        assert_eq!(parse_output("", "tabula: tabula worker does not take --events\n"), QueueResult::Failed { message: OLD_CLI.into() });
        // A CLI from before tabula worker existed.
        assert_eq!(parse_output("", "tabula: unknown command \"worker\"; run tabula help\n"), QueueResult::Failed { message: OLD_CLI.into() });
        assert_eq!(
            parse_output("", "node:internal/modules/cjs/loader:1228\n  throw err;\nError: Cannot find module 'x'\n"),
            QueueResult::Failed { message: "tabula worker queue did not answer: Error: Cannot find module 'x'".into() }
        );
        assert_eq!(parse_output("", ""), QueueResult::Failed { message: "tabula worker queue did not answer: it printed nothing".into() });
    }

    #[test]
    fn asks_the_cli_and_gives_up_on_one_that_hangs() {
        assert_eq!(check(&fake_cli("ok"), QUEUE_TIMEOUT), QueueResult::Ok { queued: 2, running: 0, worker_last_seen: None });
        assert_eq!(check(&fake_cli("old"), QUEUE_TIMEOUT), QueueResult::Failed { message: OLD_CLI.into() });
        let started = Instant::now();
        assert_eq!(
            check(&fake_cli("slowqueue"), Duration::from_secs(1)),
            QueueResult::Failed { message: "tabula worker queue did not answer within 1 s".into() }
        );
        assert!(started.elapsed() < Duration::from_secs(10));
        let mut missing = fake_cli("ok");
        missing.cli = missing.cli.with_file_name("missing.mjs");
        assert!(matches!(check(&missing, QUEUE_TIMEOUT), QueueResult::Failed { message } if message.contains("set \"cli\" in")));
    }
}
