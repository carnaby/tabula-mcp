//! Runs the tray. One thread applies every input to the model in order, shows the result and carries out the
//! effects. Handlers on the UI's main thread (menu, tray icon, window commands) only send inputs: the main thread
//! never waits for this thread, so Tauri calls made from here (which run on the main thread) cannot deadlock.
//!
//! Threading rule: the UI's main thread never takes a lock the controller holds while it calls Tauri. Menu clicks,
//! tray clicks and commands only send inputs; one controller thread applies them in order and renders; Tauri's own
//! calls (`set_icon`, `emit`, …) then hop to the main thread, which is free. The only lock both sides take is the
//! latest snapshot's, and the controller never holds it across a call.
//!
//! The model's contract: every [`Effect::CheckQueue`] is answered by exactly one [`Input::Queue`] and every
//! [`Effect::RunDoctor`] ends in exactly one [`Input::DoctorDone`], whatever fails (an [`Answer`] makes sure of it);
//! otherwise no queue check would run again, or Start would stay disabled.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::config::{self, Paths};
use crate::queue::{self, QUEUE_TIMEOUT};
use crate::state::{Effect, Input, Model, QueueResult, Snapshot, WorkerEvent};
use crate::worker::{self, Lines, Output, Sink, WorkerProcess};

/// How long a killed process is awaited before the tray goes on without it.
const KILL_WAIT: Duration = Duration::from_secs(5);

/// How long Quit lets the worker end by itself once it reported `stopped`.
const AFTER_STOPPED: Duration = Duration::from_secs(2);

/// What the controller shows and asks of the desktop.
pub trait Ui: Send + Sync + 'static {
    fn render(&self, snapshot: &Snapshot);
    fn notify(&self, queued: u32);
    fn exit(&self);
}

#[derive(Clone, Copy, Debug)]
pub struct Timing {
    /// How often the queue is checked when nothing else asks for it.
    pub queue_every: Duration,
    /// How long Quit waits for the tray's worker to give its job back.
    pub quit_wait: Duration,
    pub queue_timeout: Duration,
    /// How long `tabula worker doctor` may take (it transcribes a sample and may load a model first).
    pub doctor_timeout: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Timing {
            queue_every: Duration::from_secs(60),
            quit_wait: Duration::from_secs(15),
            queue_timeout: QUEUE_TIMEOUT,
            doctor_timeout: Duration::from_secs(300),
        }
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// One input owed to the controller: the first [`Answer::send`] goes out, later ones are dropped, and an answer
/// dropped unsent (its thread panicked or never started) sends its fallback.
struct Answer {
    tx: Sender<Input>,
    fallback: Mutex<Option<Input>>,
}

impl Answer {
    fn new(tx: &Sender<Input>, fallback: Input) -> Answer {
        Answer { tx: tx.clone(), fallback: Mutex::new(Some(fallback)) }
    }

    fn send(&self, input: Input) {
        if lock(&self.fallback).take().is_some() {
            let _ = self.tx.send(input);
        }
    }
}

impl Drop for Answer {
    fn drop(&mut self) {
        if let Some(fallback) = self.fallback.get_mut().unwrap_or_else(PoisonError::into_inner).take() {
            let _ = self.tx.send(fallback);
        }
    }
}

/// A handle to the controller's thread; cheap to call from any thread.
pub struct Controller {
    tx: Sender<Input>,
    latest: Arc<Mutex<Snapshot>>,
}

impl Controller {
    /// Start the controller thread and the queue ticker (a check now, then every `timing.queue_every`).
    pub fn start(paths: Paths, ui: Arc<dyn Ui>, timing: Timing) -> Controller {
        let (tx, rx) = mpsc::channel();
        let latest = Arc::new(Mutex::new(Model::new().snapshot()));
        {
            let (tx, latest) = (tx.clone(), Arc::clone(&latest));
            thread::Builder::new()
                .name("tabula controller".into())
                .spawn(move || run(rx, tx, paths, ui, latest, timing))
                .expect("the controller thread starts");
        }
        {
            let tx = tx.clone();
            thread::Builder::new()
                .name("tabula queue ticker".into())
                .spawn(move || loop {
                    if tx.send(Input::QueueTick).is_err() {
                        return;
                    }
                    thread::sleep(timing.queue_every);
                })
                .expect("the queue ticker starts");
        }
        Controller { tx, latest }
    }

    pub fn send(&self, input: Input) {
        let _ = self.tx.send(input);
    }

    /// What the tray shows now (for the window's first paint).
    pub fn snapshot(&self) -> Snapshot {
        lock(&self.latest).clone()
    }
}

/// The tray's worker process, and whether it reported `stopped` (set by its sink, read by Quit).
struct Worker {
    process: Arc<WorkerProcess>,
    stopped: Arc<AtomicBool>,
}

fn run(rx: Receiver<Input>, tx: Sender<Input>, paths: Paths, ui: Arc<dyn Ui>, latest: Arc<Mutex<Snapshot>>, timing: Timing) {
    let mut model = Model::new();
    let mut worker: Option<Worker> = None;
    let mut doctor: Option<Arc<WorkerProcess>> = None;
    for input in rx {
        match input {
            Input::Exited { .. } => worker = None,
            Input::DoctorDone { .. } => doctor = None,
            _ => {}
        }
        let effects = model.apply(input, now_ms());
        let snapshot = model.snapshot();
        *lock(&latest) = snapshot.clone();
        ui.render(&snapshot);
        for effect in effects {
            match effect {
                Effect::Spawn { once } => match spawn_worker(&paths, once, &tx) {
                    Ok(w) => worker = Some(w),
                    Err(message) => {
                        let _ = tx.send(Input::SpawnFailed { message });
                    }
                },
                Effect::SendStop => {
                    if let Some(w) = &worker {
                        w.process.send_stop();
                    }
                }
                Effect::CheckQueue => check_queue(&paths, &tx, timing.queue_timeout),
                Effect::Notify { queued } => ui.notify(queued),
                Effect::RunDoctor => doctor = run_doctor(&paths, &tx, timing.doctor_timeout),
                Effect::ExitAfterStop => {
                    let (w, d, ui, wait) = (worker.take(), doctor.take(), Arc::clone(&ui), timing.quit_wait);
                    // On a thread of its own: the controller keeps taking the worker's output meanwhile.
                    thread::spawn(move || {
                        end(d);
                        if let Some(w) = w {
                            quit_worker(&w, wait);
                        }
                        ui.exit();
                    });
                }
                Effect::Exit => {
                    end(doctor.take());
                    ui.exit();
                }
            }
        }
    }
}

/// End a process at once (a doctor run still going at Quit).
fn end(process: Option<Arc<WorkerProcess>>) {
    if let Some(p) = process {
        p.kill_tree();
        p.wait_exit(KILL_WAIT);
    }
}

/// Quit with the worker asked to stop: wait at most `wait` for it to end or report `stopped`, give it a moment to end
/// after `stopped`, then end what is left by force.
fn quit_worker(w: &Worker, wait: Duration) {
    let deadline = Instant::now() + wait;
    let mut ended = false;
    while !ended && !w.stopped.load(Ordering::SeqCst) && Instant::now() < deadline {
        ended = w.process.wait_exit(Duration::from_millis(50));
    }
    let grace = if w.stopped.load(Ordering::SeqCst) { AFTER_STOPPED } else { Duration::ZERO };
    if !ended && !w.process.wait_exit(grace) {
        w.process.kill_tree();
        w.process.wait_exit(KILL_WAIT);
    }
}

fn spawn_worker(paths: &Paths, once: bool, tx: &Sender<Input>) -> Result<Worker, String> {
    let cfg = config::load(paths)?;
    worker::check_cli(&cfg)?;
    let args: &[&str] = if once { &["worker", "--once", "--events"] } else { &["worker", "--events"] };
    let stopped = Arc::new(AtomicBool::new(false));
    let (tx, seen) = (tx.clone(), Arc::clone(&stopped));
    // The sink runs on the process's reader threads and must never block: it only sends on an unbounded channel.
    let sink: Sink = Arc::new(move |out: Output| {
        let _ = tx.send(match out {
            Output::Event(e) => {
                if matches!(e, WorkerEvent::Stopped { .. }) {
                    seen.store(true, Ordering::SeqCst);
                }
                Input::Event(e)
            }
            Output::Invalid(line) => Input::Invalid(line),
            Output::Text(line) | Output::Stderr(line) => Input::Stderr(line),
            Output::Exited(code) => Input::Exited { code },
        });
    });
    let process = WorkerProcess::start(worker::command(&cfg, args), Lines::Events, sink).map_err(|e| worker::spawn_error(&cfg, &e))?;
    Ok(Worker { process, stopped })
}

/// `tabula worker queue --json` on a thread of its own; always answered with one [`Input::Queue`].
fn check_queue(paths: &Paths, tx: &Sender<Input>, timeout: Duration) {
    let paths = paths.clone();
    let answer = Answer::new(tx, Input::Queue(QueueResult::Failed { message: "the queue check ended without an answer".to_string() }));
    // Should the thread not start, the closure is dropped with the answer, which then sends its fallback.
    let _ = thread::Builder::new().name("tabula queue check".into()).spawn(move || {
        let result = match config::load(&paths) {
            Ok(cfg) => queue::check(&cfg, timeout),
            Err(message) => QueueResult::Failed { message },
        };
        answer.send(Input::Queue(result));
    });
}

/// `tabula worker doctor`, its lines into the log; always ends with one [`Input::DoctorDone`]. One that takes longer
/// than `timeout` is ended. Returns the running process (to end it at Quit).
fn run_doctor(paths: &Paths, tx: &Sender<Input>, timeout: Duration) -> Option<Arc<WorkerProcess>> {
    let done = Arc::new(Answer::new(tx, Input::DoctorDone { code: None }));
    let fail = |message: String| {
        let _ = tx.send(Input::DoctorLine(format!("FAIL  {message}")));
        done.send(Input::DoctorDone { code: None });
        None
    };
    let cfg = match config::load(paths) {
        Ok(cfg) => cfg,
        Err(message) => return fail(message),
    };
    if let Err(message) = worker::check_cli(&cfg) {
        return fail(message);
    }
    let sink: Sink = {
        let (tx, done) = (tx.clone(), Arc::clone(&done));
        // Runs on the process's reader threads: it only sends, never waits.
        Arc::new(move |out: Output| match out {
            Output::Exited(code) => done.send(Input::DoctorDone { code }),
            Output::Event(_) => {}
            Output::Invalid(line) | Output::Text(line) | Output::Stderr(line) => {
                let _ = tx.send(Input::DoctorLine(line));
            }
        })
    };
    let process = match WorkerProcess::start(worker::command(&cfg, &["worker", "doctor"]), Lines::Text, sink) {
        Ok(p) => p,
        Err(e) => return fail(worker::spawn_error(&cfg, &e)),
    };
    process.close_input();
    let (watched, tx) = (Arc::clone(&process), tx.clone());
    // Should this thread not start, the doctor still ends through its sink; only a hang would then go unnoticed.
    let _ = thread::Builder::new().name("tabula doctor timeout".into()).spawn(move || {
        if watched.wait_exit(timeout) {
            return; // its end went out through the sink
        }
        let _ = tx.send(Input::DoctorLine(format!("FAIL  tabula worker doctor did not finish within {} s: the tray ended it", timeout.as_secs())));
        watched.kill_tree();
        if !watched.wait_exit(KILL_WAIT) {
            done.send(Input::DoctorDone { code: None });
        }
    });
    Some(process)
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Instant;

    use super::*;
    use crate::state::Icon;
    use crate::worker::testing::fake_cli;

    #[derive(Default)]
    struct Recorder {
        last: Mutex<Option<Snapshot>>,
        notified: Mutex<Vec<u32>>,
        exits: AtomicUsize,
    }

    impl Ui for Recorder {
        fn render(&self, snapshot: &Snapshot) {
            *lock(&self.last) = Some(snapshot.clone());
        }
        fn notify(&self, queued: u32) {
            lock(&self.notified).push(queued);
        }
        fn exit(&self) {
            self.exits.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn until(what: &str, check: impl Fn() -> bool) {
        let end = Instant::now() + Duration::from_secs(15);
        while !check() {
            assert!(Instant::now() < end, "timed out waiting: {what}");
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn test_timing() -> Timing {
        Timing {
            queue_every: Duration::from_secs(3600),
            quit_wait: Duration::from_secs(1),
            queue_timeout: Duration::from_secs(15),
            doctor_timeout: Duration::from_secs(15),
        }
    }

    /// The fake CLI in `mode`, found through tray.json in its data folder.
    fn fake_paths(mode: &str) -> Paths {
        let cfg = fake_cli(mode);
        let data = cfg.file.parent().unwrap().to_path_buf();
        write_tray_json(&data, &serde_json::json!({ "node": "node", "cli": &cfg.cli }).to_string());
        Paths { data: data.clone(), tabula_home: data }
    }

    fn write_tray_json(data: &Path, text: &str) {
        std::fs::write(data.join("tray.json"), text).unwrap();
    }

    fn set_mode(paths: &Paths, mode: &str) {
        std::fs::write(paths.data.join("mode"), mode).unwrap();
    }

    fn controller_with(mode: &str, timing: Timing) -> (Controller, Arc<Recorder>, Paths) {
        let paths = fake_paths(mode);
        let ui = Arc::new(Recorder::default());
        (Controller::start(paths.clone(), ui.clone(), timing), ui, paths)
    }

    fn controller(mode: &str) -> (Controller, Arc<Recorder>) {
        let (ctl, ui, _) = controller_with(mode, test_timing());
        (ctl, ui)
    }

    fn logged(ctl: &Controller, text: &str) -> bool {
        ctl.snapshot().log.iter().any(|l| l.text.contains(text))
    }

    #[test]
    fn checks_the_queue_then_starts_and_stops_the_worker() {
        let (ctl, ui) = controller("ok");
        until("the first queue check", || ctl.snapshot().queue.text == "2 waiting · 0 being transcribed");
        // The snapshot is published before the effects run: wait for the notification itself.
        until("the notification", || *lock(&ui.notified) == vec![2]);
        assert_eq!(ctl.snapshot().icon, Icon::Waiting);
        ctl.send(Input::Start { once: false });
        until("the worker waits for jobs", || ctl.snapshot().headline == "Waiting for jobs");
        ctl.send(Input::Stop);
        until("the worker stopped", || {
            let s = ctl.snapshot();
            s.headline == "Worker stopped" && s.can_start
        });
        until("the window was told", || lock(&ui.last).as_ref().is_some_and(|s| s.headline == "Worker stopped"));
        assert_eq!(ui.exits.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn quit_waits_for_a_worker_that_ignores_stop_then_ends_it_and_exits() {
        let (ctl, ui) = controller("stubborn");
        ctl.send(Input::Start { once: false });
        until("the worker waits for jobs", || ctl.snapshot().headline == "Waiting for jobs");
        let asked = Instant::now();
        ctl.send(Input::Quit);
        until("the tray exits", || ui.exits.load(Ordering::SeqCst) == 1);
        assert!(asked.elapsed() >= Duration::from_millis(900), "Quit waited for the worker first");
    }

    #[test]
    fn quit_exits_as_soon_as_the_worker_stopped() {
        let (ctl, ui, _) = controller_with("ok", Timing { quit_wait: Duration::from_secs(30), ..test_timing() });
        ctl.send(Input::Start { once: false });
        until("the worker waits for jobs", || ctl.snapshot().headline == "Waiting for jobs");
        let asked = Instant::now();
        ctl.send(Input::Quit);
        until("the tray exits", || ui.exits.load(Ordering::SeqCst) == 1);
        assert!(asked.elapsed() < Duration::from_secs(10), "Quit did not wait for the whole quit time");
        thread::sleep(Duration::from_millis(300));
        assert_eq!(ui.exits.load(Ordering::SeqCst), 1, "the tray exits once");
    }

    #[test]
    fn quit_without_a_worker_exits_at_once() {
        let (ctl, ui) = controller("ok");
        ctl.send(Input::Quit);
        until("the tray exits", || ui.exits.load(Ordering::SeqCst) == 1);
    }

    #[test]
    fn a_missing_cli_is_an_error_that_names_the_setting() {
        let cfg = fake_cli("ok");
        let data = cfg.file.parent().unwrap().to_path_buf();
        std::fs::write(&cfg.file, serde_json::json!({ "cli": data.join("missing.mjs") }).to_string()).unwrap();
        let ui = Arc::new(Recorder::default());
        let ctl = Controller::start(Paths { data: data.clone(), tabula_home: data }, ui, Timing::default());
        until("the queue check failed", || ctl.snapshot().queue.error);
        ctl.send(Input::Start { once: true });
        until("the start failed", || ctl.snapshot().headline.contains("set \"cli\" in"));
        assert!(ctl.snapshot().can_start);
    }

    #[test]
    fn a_failed_queue_check_does_not_block_the_next_one() {
        let (ctl, _ui, paths) = controller_with("slowqueue", Timing { queue_timeout: Duration::from_secs(1), ..test_timing() });
        until("the check timed out", || ctl.snapshot().queue.text == "tabula worker queue did not answer within 1 s");
        let good = std::fs::read_to_string(paths.tray_json()).unwrap();
        set_mode(&paths, "ok");
        write_tray_json(&paths.data, "{ node: ");
        ctl.send(Input::QueueTick);
        until("the settings were refused", || ctl.snapshot().queue.text.contains("tray.json is not valid"));
        write_tray_json(&paths.data, &serde_json::json!({ "node": "tabula-no-such-node", "cli": paths.data.join("fake cli.mjs") }).to_string());
        ctl.send(Input::QueueTick);
        until("node was not found", || ctl.snapshot().queue.text.starts_with("Node.js was not found"));
        write_tray_json(&paths.data, &good);
        ctl.send(Input::QueueTick);
        until("the queue is known again", || ctl.snapshot().queue.text == "2 waiting · 0 being transcribed");
    }

    #[test]
    fn the_doctor_runs_and_start_is_possible_again() {
        let (ctl, _ui) = controller("ok");
        until("the first queue check", || ctl.snapshot().queue.checked_at_ms.is_some());
        ctl.send(Input::Doctor);
        until("the doctor finished", || {
            let s = ctl.snapshot();
            logged(&ctl, "Everything works.") && s.can_doctor && s.can_start
        });
    }

    #[test]
    fn a_doctor_that_cannot_start_can_run_again() {
        let (ctl, _ui, paths) = controller_with("ok", test_timing());
        write_tray_json(&paths.data, &serde_json::json!({ "cli": paths.data.join("missing.mjs") }).to_string());
        ctl.send(Input::Doctor);
        until("the doctor failed", || logged(&ctl, "set \"cli\" in") && ctl.snapshot().can_doctor);
        let failed = ctl.snapshot().log.into_iter().find(|l| l.text.contains("set \"cli\" in")).unwrap();
        assert!(failed.error, "the failure is a red line: {}", failed.text);
        write_tray_json(&paths.data, &serde_json::json!({ "cli": paths.data.join("fake cli.mjs") }).to_string());
        ctl.send(Input::Doctor);
        until("the doctor ran", || logged(&ctl, "Everything works.") && ctl.snapshot().can_start);
    }

    #[test]
    fn a_doctor_that_hangs_is_ended_after_its_timeout() {
        let (ctl, _ui) = {
            let (ctl, ui, _) = controller_with("slowdoctor", Timing { doctor_timeout: Duration::from_secs(1), ..test_timing() });
            (ctl, ui)
        };
        let asked = Instant::now();
        ctl.send(Input::Doctor);
        until("the doctor was ended", || logged(&ctl, "did not finish within 1 s") && ctl.snapshot().can_doctor);
        assert!(asked.elapsed() >= Duration::from_millis(900));
        assert!(ctl.snapshot().can_start);
    }

    /// Every input on `rx` until `quiet` passes without one.
    fn drain(rx: &Receiver<Input>, quiet: Duration) -> Vec<Input> {
        let mut all = Vec::new();
        while let Ok(input) = rx.recv_timeout(quiet) {
            all.push(input);
        }
        all
    }

    fn queue_answers(all: &[Input]) -> Vec<&QueueResult> {
        all.iter().filter_map(|i| if let Input::Queue(r) = i { Some(r) } else { None }).collect()
    }

    fn doctor_ends(all: &[Input]) -> usize {
        all.iter().filter(|i| matches!(i, Input::DoctorDone { .. })).count()
    }

    #[test]
    fn every_queue_check_is_answered_exactly_once() {
        let check = |paths: &Paths, timeout: Duration| {
            let (tx, rx) = mpsc::channel();
            check_queue(paths, &tx, timeout);
            drop(tx);
            let all = drain(&rx, Duration::from_secs(20));
            let answers = queue_answers(&all);
            assert_eq!(answers.len(), 1, "{all:?}");
            answers[0].clone()
        };
        let paths = fake_paths("ok");
        assert!(matches!(check(&paths, Duration::from_secs(15)), QueueResult::Ok { queued: 2, .. }));
        set_mode(&paths, "slowqueue");
        assert!(matches!(check(&paths, Duration::from_secs(1)), QueueResult::Failed { message } if message.contains("within 1 s")));
        write_tray_json(&paths.data, "{ node: ");
        assert!(matches!(check(&paths, Duration::from_secs(15)), QueueResult::Failed { message } if message.contains("is not valid")));
        write_tray_json(&paths.data, &serde_json::json!({ "node": "tabula-no-such-node", "cli": paths.data.join("fake cli.mjs") }).to_string());
        assert!(matches!(check(&paths, Duration::from_secs(15)), QueueResult::Failed { message } if message.starts_with("Node.js was not found")));
    }

    #[test]
    fn every_doctor_run_ends_exactly_once() {
        let run = |paths: &Paths, timeout: Duration| {
            let (tx, rx) = mpsc::channel();
            let process = run_doctor(paths, &tx, timeout);
            drop(tx);
            // Longer than the drain wait of a killed process, so a second end would show up.
            let all = drain(&rx, Duration::from_secs(4));
            drop(process);
            assert_eq!(doctor_ends(&all), 1, "{all:?}");
            assert!(matches!(all.last(), Some(Input::DoctorDone { .. })), "the end comes last: {all:?}");
            all
        };
        let paths = fake_paths("ok");
        let all = run(&paths, Duration::from_secs(15));
        assert!(all.contains(&Input::DoctorLine("Everything works.".into())), "{all:?}");
        assert_eq!(all.last(), Some(&Input::DoctorDone { code: Some(0) }));

        set_mode(&paths, "slowdoctor");
        let all = run(&paths, Duration::from_secs(1));
        assert!(all.iter().any(|i| matches!(i, Input::DoctorLine(l) if l.starts_with("FAIL") && l.contains("did not finish within 1 s"))), "{all:?}");

        write_tray_json(&paths.data, "{ node: ");
        let all = run(&paths, Duration::from_secs(15));
        assert!(all.iter().any(|i| matches!(i, Input::DoctorLine(l) if l.contains("is not valid"))), "{all:?}");

        write_tray_json(&paths.data, &serde_json::json!({ "node": "tabula-no-such-node", "cli": paths.data.join("fake cli.mjs") }).to_string());
        let all = run(&paths, Duration::from_secs(15));
        assert!(all.iter().any(|i| matches!(i, Input::DoctorLine(l) if l.contains("Node.js was not found"))), "{all:?}");
    }

    #[test]
    fn an_answer_is_sent_once_and_its_fallback_when_it_is_dropped() {
        let (tx, rx) = mpsc::channel();
        let answer = Answer::new(&tx, Input::DoctorDone { code: None });
        answer.send(Input::DoctorDone { code: Some(0) });
        answer.send(Input::DoctorDone { code: Some(1) });
        drop(answer);
        Answer::new(&tx, Input::DoctorDone { code: None });
        // A thread that never runs (its closure is dropped) still answers.
        let unsent = Answer::new(&tx, Input::Queue(QueueResult::Failed { message: "none".into() }));
        drop(move || unsent.send(Input::QueueTick));
        drop(tx);
        assert_eq!(
            rx.iter().collect::<Vec<_>>(),
            vec![Input::DoctorDone { code: Some(0) }, Input::DoctorDone { code: None }, Input::Queue(QueueResult::Failed { message: "none".into() })]
        );
    }
}
