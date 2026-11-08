//! The tray's processes of the CLI: `node <cli> worker [--once] --events` (event lines, "stop" on stdin) and
//! `tabula worker doctor` (plain text). Every line goes to a sink; the end of the process always comes last.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use crate::config::TrayConfig;
use crate::state::WorkerEvent;

/// Windows: a console program started by the tray gets no console window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// How long the end of a process waits for its output after it exited (a grandchild may hold a pipe open).
const DRAIN_WAIT: Duration = Duration::from_secs(2);

/// What a process sent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Output {
    Event(WorkerEvent),
    /// A stdout line of `--events` that is no event (shortened to 200 characters).
    Invalid(String),
    /// A stdout line of a plain-text command.
    Text(String),
    Stderr(String),
    /// The exit code; None when there is none (Unix: ended by a signal). A process ended with `taskkill /F` on
    /// Windows exits with 1, so None does not mean "killed". Always the last output.
    Exited(Option<i32>),
}

/// How stdout is read: event lines (tabula worker --events) or plain text (tabula worker doctor).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lines {
    Events,
    Text,
}

/// Gets every output of a process, on the process's reader threads: it must not block for long (the process writes
/// its output synchronously and would wait for the tray).
pub type Sink = Arc<dyn Fn(Output) + Send + Sync>;

/// `node <cli> <args>` without a shell (paths with spaces need no quoting), with piped stdio and the tray's own
/// environment. Windows: no console window. Elsewhere its own process group, so a hard stop ends what it started too.
pub fn command(cfg: &TrayConfig, args: &[&str]) -> Command {
    let mut c = Command::new(&cfg.node);
    c.arg(&cfg.cli).args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0);
    }
    c
}

/// Why `command` did not start, with what to set.
pub fn spawn_error(cfg: &TrayConfig, e: &io::Error) -> String {
    if e.kind() == io::ErrorKind::NotFound {
        format!("Node.js was not found ({}): install Node.js 22 or newer, or set \"node\" in {}", cfg.node.display(), cfg.file.display())
    } else {
        format!("{} could not be started ({e}): check \"node\" in {}", cfg.node.display(), cfg.file.display())
    }
}

/// The CLI must exist before node runs it (node's own message would be a stack trace).
pub fn check_cli(cfg: &TrayConfig) -> Result<(), String> {
    if cfg.cli.is_file() {
        Ok(())
    } else {
        Err(format!(
            "The tabula command was not found at {}: install it (README, \"The tabula command\") or set \"cli\" in {}",
            cfg.cli.display(),
            cfg.file.display()
        ))
    }
}

/// One stdout line of tabula worker --events.
pub fn parse_line(line: &str) -> Output {
    match serde_json::from_str::<WorkerEvent>(line) {
        Ok(event) => Output::Event(event),
        Err(_) => Output::Invalid(clip(line, 200)),
    }
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        format!("{}…", text.chars().take(max).collect::<String>())
    }
}

/// The lines of `reader` up to its end, as UTF-8 (broken bytes replaced), without line breaks; blank lines skipped.
fn each_line(reader: impl Read, mut f: impl FnMut(String)) {
    let mut reader = BufReader::new(reader);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => return,
            Ok(_) => {
                let line = String::from_utf8_lossy(&buf);
                let line = line.trim_end_matches(['\n', '\r']);
                if !line.trim().is_empty() {
                    f(line.to_string());
                }
            }
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// End `child` and everything it started at once. Windows: taskkill /T (a venv's python.exe starts the real
/// interpreter as its own child); elsewhere the process group `command` gave it.
pub fn kill_tree(child: &mut Child) {
    let pid = child.id().to_string();
    #[cfg(windows)]
    let ended = {
        use std::os::windows::process::CommandExt;
        Command::new("taskkill")
            .args(["/PID", &pid, "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    };
    #[cfg(not(windows))]
    let ended = Command::new("kill")
        .args(["-KILL", "--", &format!("-{pid}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    if !ended {
        let _ = child.kill();
    }
}

/// The sink of one process: lines pass until the end of the process was sent, later ones are dropped (but still
/// read, so nothing that holds a pipe blocks), and [`Output::Exited`] is sent once.
struct Gate {
    sink: Sink,
    closed: Mutex<bool>,
}

impl Gate {
    fn send(&self, out: Output) {
        let closed = lock(&self.closed);
        if !*closed {
            (self.sink)(out);
        }
    }

    /// Nothing passes after this; `last` (if any) is the final output.
    fn close(&self, last: Option<Output>) {
        let mut closed = lock(&self.closed);
        if !*closed {
            *closed = true;
            if let Some(out) = last {
                (self.sink)(out);
            }
        }
    }
}

/// A running process of the tray: its input, its end, and a way to end it by force.
pub struct WorkerProcess {
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
    ended: Mutex<bool>,
    ended_cv: Condvar,
}

impl WorkerProcess {
    /// Start `command` (from [`command`]); every line goes to `sink`, then [`Output::Exited`] once the process ended and
    /// both its streams were read to the end (so the model sees "stopped" before the end of the process). On an error
    /// nothing reaches `sink` and no process is left running.
    pub fn start(mut command: Command, lines: Lines, sink: Sink) -> io::Result<Arc<Self>> {
        let mut child = command.spawn()?;
        let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "the process's stdout and stderr must be piped"));
        };
        let stdin = child.stdin.take();
        let process = Arc::new(WorkerProcess { child: Mutex::new(child), stdin: Mutex::new(stdin), ended: Mutex::new(false), ended_cv: Condvar::new() });
        let gate = Arc::new(Gate { sink, closed: Mutex::new(false) });
        let fail = |e: io::Error| {
            gate.close(None);
            process.kill_tree();
            e
        };
        let out = {
            let gate = Arc::clone(&gate);
            thread::Builder::new()
                .name("tabula stdout".into())
                .spawn(move || {
                    each_line(stdout, |line| {
                        gate.send(match lines {
                            Lines::Events => parse_line(&line),
                            Lines::Text => Output::Text(line),
                        })
                    })
                })
                .map_err(fail)?
        };
        let err = {
            let gate = Arc::clone(&gate);
            thread::Builder::new()
                .name("tabula stderr".into())
                .spawn(move || each_line(stderr, |line| gate.send(Output::Stderr(line))))
                .map_err(fail)?
        };
        let watcher = Arc::clone(&process);
        let end = Arc::clone(&gate);
        thread::Builder::new()
            .name("tabula exit".into())
            .spawn(move || {
                let code = watcher.wait_for_exit();
                // A grandchild that inherited a pipe could keep it open: wait for the readers, but not forever.
                let deadline = Instant::now() + DRAIN_WAIT;
                while !(out.is_finished() && err.is_finished()) && Instant::now() < deadline {
                    thread::sleep(Duration::from_millis(20));
                }
                end.close(Some(Output::Exited(code)));
                *lock(&watcher.ended) = true;
                watcher.ended_cv.notify_all();
            })
            .map_err(fail)?;
        Ok(process)
    }

    fn wait_for_exit(&self) -> Option<i32> {
        loop {
            match lock(&self.child).try_wait() {
                Ok(Some(status)) => return status.code(),
                Ok(None) => {}
                Err(_) => return None,
            }
            thread::sleep(Duration::from_millis(50));
        }
    }

    /// Write "stop" to the process (a second one ends the worker at once). False when its input is closed.
    pub fn send_stop(&self) -> bool {
        let mut stdin = lock(&self.stdin);
        let Some(pipe) = stdin.as_mut() else { return false };
        if pipe.write_all(b"stop\n").and_then(|()| pipe.flush()).is_ok() {
            return true;
        }
        *stdin = None;
        false
    }

    /// Close the process's input (for commands that read none).
    pub fn close_input(&self) {
        *lock(&self.stdin) = None;
    }

    /// Wait at most `timeout` for the end of the process and its output. True when it ended (and
    /// [`Output::Exited`] was sent).
    pub fn wait_exit(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut ended = lock(&self.ended);
        while !*ended {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            ended = self.ended_cv.wait_timeout(ended, left).unwrap_or_else(PoisonError::into_inner).0;
        }
        true
    }

    /// End the process and everything it started (Python, ffmpeg) at once.
    pub fn kill_tree(&self) {
        kill_tree(&mut lock(&self.child));
    }
}

#[cfg(test)]
pub(crate) mod testing {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc::{self, Receiver};
    use std::sync::Arc;
    use std::time::Duration;

    use super::{Output, Sink};
    use crate::config::TrayConfig;

    /// tests/fixtures/fake-cli.mjs copied into a fresh folder whose name has a space and a diacritic, set to `mode`.
    pub fn fake_cli(mode: &str) -> TrayConfig {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!("tabula tray é {}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let cli = dir.join("fake cli.mjs");
        fs::copy(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/fake-cli.mjs"), &cli).unwrap();
        fs::write(dir.join("mode"), mode).unwrap();
        TrayConfig { node: PathBuf::from("node"), cli, file: dir.join("tray.json") }
    }

    pub fn channel() -> (Sink, Receiver<Output>) {
        let (tx, rx) = mpsc::channel();
        (Arc::new(move |out: Output| {
            let _ = tx.send(out);
        }), rx)
    }

    pub fn next(rx: &Receiver<Output>) -> Output {
        rx.recv_timeout(Duration::from_secs(15)).expect("output in time")
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::mpsc::Receiver;
    use std::time::{Duration, Instant};

    use super::testing::{channel, fake_cli, next};
    use super::*;
    use crate::state::{Attachment, ErrorKind, JobPhase, ReportRef};

    fn until_exit(rx: &Receiver<Output>) -> Vec<Output> {
        let mut all = Vec::new();
        loop {
            let out = next(rx);
            let end = matches!(out, Output::Exited(_));
            all.push(out);
            if end {
                return all;
            }
        }
    }

    #[test]
    fn parses_every_event_of_the_cli() {
        let job = r#"{"type":"job","time":"2026-11-08T10:00:00.000Z","id":"j1","attempt":1,"attachment":{"kind":"audio","duration_ms":null,"size":32044,"file_name":"voice.wav"},"report":{"id":"r1","project":"demo","title":"Player freezes"},"report_url":"https://tabula.example.com/#/reports/r1?project=demo"}"#;
        let cases = [
            (r#"{"type":"started","time":"2026-11-08T10:00:00.000Z","version":"1.3.0","once":true,"server":"https://tabula.example.com"}"#,
                WorkerEvent::Started { version: "1.3.0".into(), once: true, server: "https://tabula.example.com".into() }),
            (r#"{"type":"idle","time":"2026-11-08T10:00:00.000Z"}"#, WorkerEvent::Idle),
            (job, WorkerEvent::Job {
                id: "j1".into(), attempt: 1,
                attachment: Attachment { kind: "audio".into(), duration_ms: None, size: 32044, file_name: "voice.wav".into() },
                report: ReportRef { id: "r1".into(), project: "demo".into(), title: "Player freezes".into() },
                report_url: "https://tabula.example.com/#/reports/r1?project=demo".into(),
            }),
            (r#"{"type":"phase","time":"t","id":"j1","phase":"transcribe"}"#, WorkerEvent::Phase { id: "j1".into(), phase: JobPhase::Transcribe }),
            (r#"{"type":"phase","time":"t","id":"j1","phase":"diarize"}"#, WorkerEvent::Phase { id: "j1".into(), phase: JobPhase::Diarize }),
            (r#"{"type":"phase","time":"t","id":"j1","phase":"summarize"}"#, WorkerEvent::Phase { id: "j1".into(), phase: JobPhase::Other("summarize".into()) }),
            (r#"{"type":"progress","time":"t","id":"j1","done_ms":400,"total_ms":null}"#, WorkerEvent::Progress { id: "j1".into(), done_ms: 400, total_ms: None }),
            (r#"{"type":"done","time":"t","id":"j1","segments":2}"#, WorkerEvent::Done { id: "j1".into(), segments: 2 }),
            (r#"{"type":"failed","time":"t","id":"j1","message":"boom","retry_at":null}"#, WorkerEvent::Failed { id: "j1".into(), message: "boom".into(), retry_at: None }),
            (r#"{"type":"released","time":"t","id":"j1"}"#, WorkerEvent::Released { id: "j1".into() }),
            (r#"{"type":"log","time":"t","text":"job 0a1b2c3d: done in 3.2 s"}"#, WorkerEvent::Log { text: "job 0a1b2c3d: done in 3.2 s".into() }),
            (r#"{"type":"error","time":"t","kind":"connection","message":"cannot reach"}"#, WorkerEvent::Error { kind: ErrorKind::Connection, message: "cannot reach".into() }),
            (r#"{"type":"error","time":"t","kind":"something-new","message":"x"}"#, WorkerEvent::Error { kind: ErrorKind::Other, message: "x".into() }),
            (r#"{"type":"stopped","time":"t","done":1,"failed":0,"code":0}"#, WorkerEvent::Stopped { done: 1, failed: 0, code: 0 }),
        ];
        for (line, event) in cases {
            assert_eq!(parse_line(line), Output::Event(event), "{line}");
        }
    }

    #[test]
    fn a_line_that_is_no_event_is_reported_shortened() {
        assert_eq!(parse_line("not json"), Output::Invalid("not json".into()));
        assert!(matches!(parse_line(r#"{"type":"surprise"}"#), Output::Invalid(_)));
        assert!(matches!(parse_line(r#"{"type":"done","id":"j1"}"#), Output::Invalid(_)), "segments is missing");
        let Output::Invalid(long) = parse_line(&"x".repeat(500)) else { panic!("not reported as invalid") };
        assert_eq!(long.chars().count(), 201);
    }

    #[test]
    fn splits_lines_with_crlf_and_broken_utf8() {
        let mut lines = Vec::new();
        each_line(&b"one\r\ntwo\n\n  \nthr\xffee"[..], |l| lines.push(l));
        assert_eq!(lines, ["one", "two", "thr\u{fffd}ee"]);
    }

    #[test]
    fn runs_the_worker_and_stops_it_with_a_command() {
        let cfg = fake_cli("ok");
        let (sink, rx) = channel();
        let p = WorkerProcess::start(command(&cfg, &["worker", "--events"]), Lines::Events, sink).unwrap();
        assert!(matches!(next(&rx), Output::Event(WorkerEvent::Started { once: false, .. })));
        assert_eq!(next(&rx), Output::Event(WorkerEvent::Idle));
        assert!(p.send_stop());
        assert_eq!(until_exit(&rx), vec![Output::Event(WorkerEvent::Stopped { done: 0, failed: 0, code: 0 }), Output::Exited(Some(0))]);
        assert!(p.wait_exit(Duration::from_secs(1)));
    }

    #[test]
    fn skips_lines_that_are_no_events() {
        let cfg = fake_cli("garbage");
        let (sink, rx) = channel();
        let p = WorkerProcess::start(command(&cfg, &["worker", "--events"]), Lines::Events, sink).unwrap();
        assert!(matches!(next(&rx), Output::Event(WorkerEvent::Started { .. })));
        assert_eq!(next(&rx), Output::Invalid("not json".into()));
        assert_eq!(next(&rx), Output::Event(WorkerEvent::Idle));
        assert_eq!(next(&rx), Output::Invalid(r#"{"type":"surprise"}"#.into()));
        assert!(p.send_stop());
        assert_eq!(until_exit(&rx).last(), Some(&Output::Exited(Some(0))));
    }

    #[test]
    fn ends_a_worker_by_force_when_it_ignores_stop() {
        let cfg = fake_cli("stubborn");
        let (sink, rx) = channel();
        let p = WorkerProcess::start(command(&cfg, &["worker", "--events"]), Lines::Events, sink).unwrap();
        assert!(matches!(next(&rx), Output::Event(WorkerEvent::Started { .. })));
        assert_eq!(next(&rx), Output::Event(WorkerEvent::Idle));
        assert!(p.send_stop());
        let waited = Instant::now();
        assert!(!p.wait_exit(Duration::from_secs(1)));
        assert!(waited.elapsed() >= Duration::from_millis(900));
        p.kill_tree();
        assert!(p.wait_exit(Duration::from_secs(10)));
        assert!(matches!(until_exit(&rx).last(), Some(Output::Exited(_))));
    }

    #[test]
    fn reports_a_crash_with_its_stderr_before_the_end() {
        let cfg = fake_cli("crash");
        let (sink, rx) = channel();
        WorkerProcess::start(command(&cfg, &["worker", "--events"]), Lines::Events, sink).unwrap();
        let all = until_exit(&rx);
        assert!(all.contains(&Output::Event(WorkerEvent::Log { text: "something broke".into() })));
        assert!(all.contains(&Output::Stderr("Error: boom".into())));
        assert_eq!(all.last(), Some(&Output::Exited(Some(1))));
    }

    #[test]
    fn reads_plain_text_when_asked() {
        let cfg = fake_cli("ok");
        let (sink, rx) = channel();
        let p = WorkerProcess::start(command(&cfg, &["worker", "doctor"]), Lines::Text, sink).unwrap();
        p.close_input();
        assert_eq!(until_exit(&rx), vec![Output::Text("ok    fake doctor".into()), Output::Text("Everything works.".into()), Output::Exited(Some(0))]);
    }

    #[test]
    fn says_what_to_set_when_node_or_the_cli_is_missing() {
        let mut cfg = fake_cli("ok");
        cfg.node = PathBuf::from("tabula-no-such-node");
        let e = command(&cfg, &["worker", "--events"]).spawn().expect_err("there is no such program");
        let message = spawn_error(&cfg, &e);
        assert!(message.starts_with("Node.js was not found (tabula-no-such-node)"), "{message}");
        assert!(message.contains("set \"node\" in"), "{message}");
        cfg.cli = cfg.cli.with_file_name("missing.mjs");
        let message = check_cli(&cfg).unwrap_err();
        assert!(message.contains("set \"cli\" in"), "{message}");
        assert!(message.contains("tabula tray é"), "the path is shown as it is: {message}");
    }
}
