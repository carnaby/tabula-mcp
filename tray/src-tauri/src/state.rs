//! The tray's state: what the worker and the queue do, and what that means for the icon, the menu and the window.
//! Pure: every change comes in as an [`Input`] with the time, every action goes out as an [`Effect`].

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

/// Lines the window keeps.
pub const LOG_LINES: usize = 200;
/// The server saw a worker of this computer this recently: it runs (a waiting worker calls about every 30 s).
pub const EXTERNAL_MS: i64 = 90_000;
/// Sign-of-life times up to this long after the tray's own worker ended are that worker's own last calls.
pub const OWN_GRACE_MS: i64 = 10_000;
/// Windows shows at most 127 UTF-16 units of a tray tooltip.
pub const TOOLTIP_UNITS: usize = 127;
/// Lines kept to explain a worker that ended without an error event.
const RECENT_LINES: usize = 3;
pub const OLD_CLI: &str = "This tabula command is too old for the tray (it needs 1.3.0 or newer): run tabula update";
/// What a CLI before 1.3.0 says to `tabula worker --events` (1.2.0), or to `tabula worker` at all (older ones).
const OLD_CLI_SIGNS: [&str; 2] = ["does not take --events", "unknown command \"worker\""];

// ------------------------------------------------------------------ events of tabula worker --events

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobPhase {
    Download,
    Extract,
    Transcribe,
    Upload,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    Environment,
    Config,
    Rejected,
    Disabled,
    Connection,
    /// A kind a newer CLI may add.
    #[serde(other)]
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Attachment {
    pub kind: String,
    pub duration_ms: Option<u64>,
    pub size: u64,
    pub file_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct ReportRef {
    pub id: String,
    pub project: String,
    pub title: String,
}

/// One stdout line of `tabula worker --events` (its `time` is not needed).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WorkerEvent {
    Started { version: String, once: bool, server: String },
    Idle,
    Job { id: String, attempt: u32, attachment: Attachment, report: ReportRef, report_url: String },
    Phase { id: String, phase: JobPhase },
    Progress { id: String, done_ms: u64, total_ms: Option<u64> },
    Done { id: String, segments: u32 },
    Failed { id: String, message: String, retry_at: Option<String> },
    Released { id: String },
    Log { text: String },
    Error { kind: ErrorKind, message: String },
    Stopped { done: u32, failed: u32, code: i32 },
}

// ------------------------------------------------------------------ state

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Job {
    pub id: String,
    pub attachment: Attachment,
    pub report: ReportRef,
    pub report_url: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Progress {
    pub done_ms: u64,
    pub total_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WorkerState {
    Stopped,
    Starting,
    Idle,
    Busy { job: Job, phase: Option<JobPhase>, progress: Option<Progress> },
    Stopping,
    /// No worker of the tray, but the server saw this computer's worker less than [`EXTERNAL_MS`] ago.
    External,
    Error { kind: Option<ErrorKind>, message: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum QueueState {
    Unchecked,
    Known { queued: u32, running: u32, checked_at_ms: i64, worker_last_seen_ms: Option<i64> },
    Unknown { error: String, checked_at_ms: i64 },
}

/// What `tabula worker queue --json` answered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum QueueResult {
    Ok { queued: u32, running: u32, worker_last_seen: Option<String> },
    Failed { message: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Input {
    Start { once: bool },
    Stop,
    Quit,
    SpawnFailed { message: String },
    Event(WorkerEvent),
    /// A stdout line of the worker that is not an event.
    Invalid(String),
    Stderr(String),
    Exited { code: Option<i32> },
    QueueTick,
    Queue(QueueResult),
    Doctor,
    DoctorLine(String),
    DoctorDone { code: Option<i32> },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    Spawn { once: bool },
    SendStop,
    CheckQueue,
    Notify { queued: u32 },
    RunDoctor,
    /// Wait for the tray's worker to end (at most the Quit time, then end it by force), then exit.
    ExitAfterStop,
    Exit,
}

/// The tray icon; one PNG each for a light and a dark taskbar.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Icon {
    Stopped,
    Waiting,
    Idle,
    Busy,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub at_ms: i64,
    pub text: String,
    pub error: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobView {
    pub project: String,
    pub title: String,
    pub report_url: String,
    /// "Voice note · 2:41"
    pub recording: String,
    /// "Downloading", "Transcribing" …
    pub step: String,
    pub percent: Option<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueView {
    pub text: String,
    pub error: bool,
    pub checked_at_ms: Option<i64>,
}

/// Everything the tray and the window show, made from the model.
/// `tray/src/types.ts` mirrors these field names (camelCase) and the lowercase `Icon` values; change them together.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub icon: Icon,
    pub tooltip: String,
    pub status: String,
    pub headline: String,
    pub note: Option<String>,
    pub can_start: bool,
    pub can_stop: bool,
    pub stop_label: String,
    pub can_doctor: bool,
    pub job: Option<JobView>,
    pub queue: QueueView,
    pub log: Vec<LogLine>,
}

/// The tray's own worker process while it runs.
#[derive(Default)]
struct Run {
    stops: u8,
    started: bool,
    /// The code of its "stopped" event.
    stopped: Option<i32>,
    last_error: Option<(ErrorKind, String)>,
    recent: VecDeque<String>,
}

pub struct Model {
    worker: WorkerState,
    queue: QueueState,
    log: VecDeque<LogLine>,
    /// Trouble the running worker retries (a connection error).
    note: Option<String>,
    run: Option<Run>,
    own_ended_ms: Option<i64>,
    /// The last known count of waiting jobs; an unknown result keeps it.
    last_queued: Option<u32>,
    checking: bool,
    check_again: bool,
    doctor: bool,
    quitting: bool,
}

impl Default for Model {
    fn default() -> Self {
        Self::new()
    }
}

impl Model {
    pub fn new() -> Self {
        Model {
            worker: WorkerState::Stopped,
            queue: QueueState::Unchecked,
            log: VecDeque::new(),
            note: None,
            run: None,
            own_ended_ms: None,
            last_queued: None,
            checking: false,
            check_again: false,
            doctor: false,
            quitting: false,
        }
    }

    pub fn worker(&self) -> &WorkerState {
        &self.worker
    }

    pub fn queue(&self) -> &QueueState {
        &self.queue
    }

    pub fn apply(&mut self, input: Input, now: i64) -> Vec<Effect> {
        let mut fx = Vec::new();
        match input {
            Input::Start { once } => {
                if self.can_start() {
                    self.worker = WorkerState::Starting;
                    self.run = Some(Run::default());
                    self.note = None;
                    self.push(now, if once { "Processing the queue…" } else { "Starting the worker…" }, false);
                    fx.push(Effect::Spawn { once });
                }
            }
            Input::Stop => {
                if !self.quitting {
                    self.stop(now, &mut fx);
                }
            }
            Input::Quit => {
                if !self.quitting {
                    self.quitting = true;
                    if self.run.is_some() {
                        if self.run.as_ref().is_some_and(|r| r.stops == 0) {
                            self.stop(now, &mut fx);
                        }
                        fx.push(Effect::ExitAfterStop);
                    } else {
                        fx.push(Effect::Exit);
                    }
                }
            }
            Input::SpawnFailed { message } => {
                if self.run.take().is_some() {
                    self.own_ended_ms = Some(now);
                    self.push(now, &message, true);
                    self.worker = WorkerState::Error { kind: None, message };
                }
            }
            Input::Event(event) => self.event(event, now, &mut fx),
            Input::Invalid(line) => self.push(now, &format!("Ignored a line from the worker that is not an event: {line}"), true),
            Input::Stderr(line) => {
                if let Some(run) = self.run.as_mut() {
                    remember(&mut run.recent, &line);
                }
                self.push(now, &line, true);
            }
            Input::Exited { code } => self.exited(code, now, &mut fx),
            Input::QueueTick => self.check_queue(&mut fx),
            Input::Queue(result) => self.queue_result(result, now, &mut fx),
            Input::Doctor => {
                if self.can_doctor() {
                    self.doctor = true;
                    self.push(now, "Running tabula worker doctor…", false);
                    fx.push(Effect::RunDoctor);
                }
            }
            Input::DoctorLine(line) => {
                let error = line.starts_with("FAIL");
                self.push(now, &line, error);
            }
            Input::DoctorDone { .. } => self.doctor = false,
        }
        fx
    }

    fn stop(&mut self, now: i64, fx: &mut Vec<Effect>) {
        let Some(stops) = self.run.as_ref().map(|r| r.stops) else { return };
        if stops >= 2 {
            return;
        }
        if let Some(run) = self.run.as_mut() {
            run.stops = stops + 1;
        }
        if stops == 0 {
            self.worker = WorkerState::Stopping;
            self.note = None;
            self.push(now, "Stopping the worker; a job in progress goes back to the queue…", false);
        } else {
            self.push(now, "Ending the worker at once…", false);
        }
        fx.push(Effect::SendStop);
    }

    fn event(&mut self, event: WorkerEvent, now: i64, fx: &mut Vec<Effect>) {
        if self.run.is_none() {
            return; // a line after the end of the process
        }
        let stopping = self.worker == WorkerState::Stopping;
        match event {
            WorkerEvent::Started { .. } => {
                if let Some(run) = self.run.as_mut() {
                    run.started = true;
                }
            }
            WorkerEvent::Idle => {
                self.note = None;
                self.clear_connection_error();
                if !stopping {
                    self.worker = WorkerState::Idle;
                }
            }
            WorkerEvent::Job { id, attachment, report, report_url, .. } => {
                self.note = None;
                self.clear_connection_error();
                if !stopping {
                    self.worker = WorkerState::Busy { job: Job { id, attachment, report, report_url }, phase: None, progress: None };
                }
            }
            WorkerEvent::Phase { id, phase } => {
                if let WorkerState::Busy { job, phase: current, .. } = &mut self.worker {
                    if job.id == id {
                        *current = Some(phase);
                    }
                }
            }
            WorkerEvent::Progress { id, done_ms, total_ms } => {
                if let WorkerState::Busy { job, progress, .. } = &mut self.worker {
                    if job.id == id {
                        *progress = Some(Progress { done_ms, total_ms });
                    }
                }
            }
            WorkerEvent::Done { id, segments } => {
                let what = self.job_name(&id);
                let unit = if segments == 1 { "segment" } else { "segments" };
                self.push(now, &format!("Transcribed {what} ({segments} {unit})"), false);
                if !stopping {
                    self.worker = WorkerState::Idle;
                }
                self.check_queue(fx);
            }
            WorkerEvent::Failed { id, message, retry_at } => {
                let what = self.job_name(&id);
                let again = if retry_at.is_some() { " (the server offers it again later)" } else { "" };
                self.push(now, &format!("Failed {what}: {message}{again}"), true);
                if !stopping {
                    self.worker = WorkerState::Idle;
                }
                self.check_queue(fx);
            }
            WorkerEvent::Released { .. } => {
                self.push(now, "The job went back to the queue", false);
                self.check_queue(fx);
            }
            WorkerEvent::Log { text } => {
                if let Some(run) = self.run.as_mut() {
                    remember(&mut run.recent, &text);
                }
                self.push(now, &text, false);
            }
            WorkerEvent::Error { kind, message } => {
                if kind == ErrorKind::Connection {
                    self.note = Some(message.clone());
                }
                self.flag_error(now, &message);
                if let Some(run) = self.run.as_mut() {
                    run.last_error = Some((kind, message));
                }
            }
            WorkerEvent::Stopped { code, .. } => {
                if let Some(run) = self.run.as_mut() {
                    run.stopped = Some(code);
                }
                self.check_queue(fx);
            }
        }
    }

    /// A connection error the worker has recovered from must not be reported as the cause of a later crash.
    fn clear_connection_error(&mut self) {
        if let Some(run) = self.run.as_mut() {
            if run.last_error.as_ref().is_some_and(|(kind, _)| *kind == ErrorKind::Connection) {
                run.last_error = None;
            }
        }
    }

    fn exited(&mut self, code: Option<i32>, now: i64, fx: &mut Vec<Effect>) {
        let Some(run) = self.run.take() else { return };
        self.own_ended_ms = Some(now);
        self.note = None;
        if run.stops >= 2 {
            self.worker = WorkerState::Stopped;
            self.push(now, "The worker was ended at once; a job in progress goes back to the queue when its lease runs out (10 min)", false);
        } else if run.stopped.is_some() && code == Some(0) {
            self.worker = WorkerState::Stopped;
        } else {
            let (kind, message) = failure(&run, code);
            self.push(now, &format!("The worker stopped: {message}"), true);
            self.worker = WorkerState::Error { kind, message };
        }
        self.check_queue(fx);
    }

    fn check_queue(&mut self, fx: &mut Vec<Effect>) {
        if self.quitting {
            return;
        }
        if self.checking {
            self.check_again = true;
        } else {
            self.checking = true;
            fx.push(Effect::CheckQueue);
        }
    }

    fn queue_result(&mut self, result: QueueResult, now: i64, fx: &mut Vec<Effect>) {
        self.checking = false;
        match result {
            QueueResult::Ok { queued, running, worker_last_seen } => {
                let seen = worker_last_seen.as_deref().and_then(parse_iso_ms);
                self.queue = QueueState::Known { queued, running, checked_at_ms: now, worker_last_seen_ms: seen };
                self.detect_external(seen, now);
                let rose = queued > 0 && self.last_queued.is_none_or(|q| q == 0);
                self.last_queued = Some(queued);
                if rose && !self.quitting && matches!(self.worker, WorkerState::Stopped | WorkerState::Error { .. }) {
                    fx.push(Effect::Notify { queued });
                }
            }
            QueueResult::Failed { message } => {
                // Without a queue answer there is no sign of life: an outside worker can no longer be assumed.
                if self.worker == WorkerState::External {
                    self.worker = WorkerState::Stopped;
                    self.push(now, "Cannot tell whether the worker outside the tray still runs", false);
                }
                self.queue = QueueState::Unknown { error: message, checked_at_ms: now };
            }
        }
        if self.check_again && !self.quitting {
            self.check_again = false;
            self.checking = true;
            fx.push(Effect::CheckQueue);
        }
    }

    /// External: no worker of the tray, and the server saw one of this computer recently — later than the tray's own.
    /// This compares the server's clock with the local one, so it assumes they differ by well under
    /// `OWN_GRACE_MS` (about 10 s; NTP keeps ordinary computers far closer).
    fn detect_external(&mut self, seen: Option<i64>, now: i64) {
        if self.run.is_some() || self.quitting {
            return;
        }
        if !matches!(self.worker, WorkerState::Stopped | WorkerState::Error { .. } | WorkerState::External) {
            return;
        }
        let alive = seen.is_some_and(|s| now - s < EXTERNAL_MS && self.own_ended_ms.is_none_or(|end| s > end + OWN_GRACE_MS));
        if alive && self.worker != WorkerState::External {
            self.worker = WorkerState::External;
            self.push(now, "A worker of this computer runs outside the tray", false);
        } else if !alive && self.worker == WorkerState::External {
            self.worker = WorkerState::Stopped;
            self.push(now, "The worker outside the tray stopped", false);
        }
    }

    fn job_name(&self, id: &str) -> String {
        match &self.worker {
            WorkerState::Busy { job, .. } if job.id == id => format!("{}: {}", job.report.project, job.report.title),
            _ => format!("job {}", id.chars().take(8).collect::<String>()),
        }
    }

    fn push(&mut self, now: i64, text: &str, error: bool) {
        self.log.push_back(LogLine { at_ms: now, text: text.to_string(), error });
        while self.log.len() > LOG_LINES {
            self.log.pop_front();
        }
    }

    /// An error event: the log line that already says it turns red, else the message becomes a line of its own.
    fn flag_error(&mut self, now: i64, message: &str) {
        if self.log.back().is_some_and(|l| l.text.contains(message)) {
            if let Some(last) = self.log.back_mut() {
                last.error = true;
            }
        } else {
            self.push(now, message, true);
        }
    }

    pub fn can_start(&self) -> bool {
        self.run.is_none() && !self.doctor && !self.quitting && matches!(self.worker, WorkerState::Stopped | WorkerState::Error { .. })
    }

    pub fn can_stop(&self) -> bool {
        !self.quitting && self.run.as_ref().is_some_and(|r| r.stops < 2)
    }

    pub fn can_doctor(&self) -> bool {
        self.run.is_none() && !self.doctor && !self.quitting && self.worker != WorkerState::External
    }

    pub fn icon(&self) -> Icon {
        match &self.worker {
            WorkerState::Error { .. } => Icon::Error,
            WorkerState::Busy { .. } => Icon::Busy,
            WorkerState::Starting | WorkerState::Idle | WorkerState::Stopping | WorkerState::External => Icon::Idle,
            WorkerState::Stopped => match &self.queue {
                QueueState::Unknown { .. } => Icon::Error,
                QueueState::Known { queued, .. } if *queued > 0 => Icon::Waiting,
                _ => Icon::Stopped,
            },
        }
    }

    pub fn tooltip(&self) -> String {
        let text = match &self.worker {
            WorkerState::Error { message, .. } => message.clone(),
            WorkerState::Busy { job, phase, progress } => {
                format!("{} – {}: {}", busy_words(*phase, *progress), job.report.project, job.report.title)
            }
            WorkerState::Starting => "Starting the worker…".to_string(),
            WorkerState::Idle => "Waiting for jobs".to_string(),
            WorkerState::Stopping => "Stopping the worker…".to_string(),
            WorkerState::External => "Running outside the tray".to_string(),
            WorkerState::Stopped => match &self.queue {
                QueueState::Unknown { error, .. } => error.clone(),
                QueueState::Known { queued, .. } if *queued > 0 => waiting(*queued),
                _ => "Tabula worker: stopped".to_string(),
            },
        };
        clip_utf16(text.lines().next().unwrap_or(""), TOOLTIP_UNITS)
    }

    /// The menu's first line, e.g. "2 waiting · worker stopped".
    pub fn status_line(&self) -> String {
        let queue = match &self.queue {
            QueueState::Unchecked => "checking the queue".to_string(),
            QueueState::Known { queued: 0, .. } => "nothing waiting".to_string(),
            QueueState::Known { queued, .. } => format!("{queued} waiting"),
            QueueState::Unknown { .. } => "queue unknown".to_string(),
        };
        let worker = match &self.worker {
            WorkerState::Stopped => "worker stopped".to_string(),
            WorkerState::Starting => "worker starting".to_string(),
            WorkerState::Idle => "waiting for jobs".to_string(),
            WorkerState::Busy { phase, progress, .. } => busy_words(*phase, *progress).to_lowercase(),
            WorkerState::Stopping => "worker stopping".to_string(),
            WorkerState::External => "running outside the tray".to_string(),
            WorkerState::Error { .. } => "worker error".to_string(),
        };
        format!("{queue} · {worker}")
    }

    fn headline(&self) -> String {
        match &self.worker {
            WorkerState::Stopped => "Worker stopped".to_string(),
            WorkerState::Starting => "Starting the worker…".to_string(),
            WorkerState::Idle => "Waiting for jobs".to_string(),
            WorkerState::Busy { phase, progress, .. } => busy_words(*phase, *progress),
            WorkerState::Stopping => "Stopping the worker…".to_string(),
            WorkerState::External => "Running outside the tray".to_string(),
            WorkerState::Error { message, .. } => format!("Stopped with an error: {message}"),
        }
    }

    fn queue_view(&self) -> QueueView {
        match &self.queue {
            QueueState::Unchecked => QueueView { text: "Not checked yet".to_string(), error: false, checked_at_ms: None },
            QueueState::Known { queued, running, checked_at_ms, .. } => {
                QueueView { text: format!("{queued} waiting · {running} being transcribed"), error: false, checked_at_ms: Some(*checked_at_ms) }
            }
            QueueState::Unknown { error, checked_at_ms } => QueueView { text: error.clone(), error: true, checked_at_ms: Some(*checked_at_ms) },
        }
    }

    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            icon: self.icon(),
            tooltip: self.tooltip(),
            status: self.status_line(),
            headline: self.headline(),
            note: self.note.clone(),
            can_start: self.can_start(),
            can_stop: self.can_stop(),
            stop_label: if self.worker == WorkerState::Stopping { "Stop now" } else { "Stop" }.to_string(),
            can_doctor: self.can_doctor(),
            job: match &self.worker {
                WorkerState::Busy { job, phase, progress } => Some(JobView {
                    project: job.report.project.clone(),
                    title: job.report.title.clone(),
                    report_url: job.report_url.clone(),
                    recording: recording(&job.attachment),
                    step: phase_words(*phase).to_string(),
                    percent: if *phase == Some(JobPhase::Transcribe) { percent(*progress) } else { None },
                }),
                _ => None,
            },
            queue: self.queue_view(),
            log: self.log.iter().cloned().collect(),
        }
    }
}

/// Why the tray's worker ended badly: an old CLI, its last error event, its last lines, or its exit code.
fn failure(run: &Run, code: Option<i32>) -> (Option<ErrorKind>, String) {
    if !run.started && run.recent.iter().any(|l| OLD_CLI_SIGNS.iter().any(|sign| l.contains(sign))) {
        return (None, OLD_CLI.to_string());
    }
    if let Some((kind, message)) = &run.last_error {
        return (Some(*kind), message.clone());
    }
    if !run.recent.is_empty() {
        return (None, run.recent.iter().cloned().collect::<Vec<_>>().join(" | "));
    }
    let message = match code {
        Some(c) => format!("the worker ended with exit code {c}"),
        None => "the worker ended unexpectedly".to_string(),
    };
    (None, message)
}

fn remember(recent: &mut VecDeque<String>, line: &str) {
    recent.push_back(line.to_string());
    while recent.len() > RECENT_LINES {
        recent.pop_front();
    }
}

fn waiting(n: u32) -> String {
    if n == 1 { "1 recording waiting".to_string() } else { format!("{n} recordings waiting") }
}

fn phase_words(phase: Option<JobPhase>) -> &'static str {
    match phase {
        None => "Starting the job",
        Some(JobPhase::Download) => "Downloading",
        Some(JobPhase::Extract) => "Extracting the audio",
        Some(JobPhase::Transcribe) => "Transcribing",
        Some(JobPhase::Upload) => "Uploading the transcript",
    }
}

fn percent(progress: Option<Progress>) -> Option<u8> {
    let p = progress?;
    let total = p.total_ms.filter(|t| *t > 0)?;
    Some((p.done_ms.saturating_mul(100) / total).min(100) as u8)
}

/// "Transcribing 42 %", or the phase alone while the percentage is unknown.
fn busy_words(phase: Option<JobPhase>, progress: Option<Progress>) -> String {
    match (phase, percent(progress)) {
        (Some(JobPhase::Transcribe), Some(p)) => format!("Transcribing {p} %"),
        _ => phase_words(phase).to_string(),
    }
}

fn recording(a: &Attachment) -> String {
    let what = match a.kind.as_str() {
        "audio" => "Voice note",
        "video" => "Screen recording",
        _ => "Recording",
    };
    match a.duration_ms {
        Some(ms) => format!("{what} · {}", format_clock(ms)),
        None => what.to_string(),
    }
}

/// "0:05", "2:41", "1:02:03", like the CLI and the web UI.
pub fn format_clock(ms: u64) -> String {
    let s = ms / 1000;
    let (h, m, ss) = (s / 3600, (s % 3600) / 60, s % 60);
    if h > 0 { format!("{h}:{m:02}:{ss:02}") } else { format!("{m}:{ss:02}") }
}

/// `text` in at most `max` UTF-16 units, cut at a character and ended with "…" when it is longer.
pub fn clip_utf16(text: &str, max: usize) -> String {
    if text.encode_utf16().count() <= max {
        return text.to_string();
    }
    if max < 2 {
        return if max == 0 { String::new() } else { "…".to_string() };
    }
    let mut out = String::new();
    let mut units = 0;
    for c in text.chars() {
        if units + c.len_utf16() > max - 1 {
            break;
        }
        units += c.len_utf16();
        out.push(c);
    }
    out.push('…');
    out
}

/// Only web pages are opened from the window (the report link); never a file or a program.
pub fn is_web_url(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://")
}

/// Milliseconds since 1970 of the server's `toISOString()` times ("2026-11-08T10:00:00.000Z"); None for anything else.
pub fn parse_iso_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' || b[b.len() - 1] != b'Z' {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> {
        let t = s.get(from..to)?;
        if t.bytes().all(|c| c.is_ascii_digit()) { t.parse().ok() } else { None }
    };
    let (y, mo, d, h, mi, sec) = (num(0, 4)?, num(5, 7)?, num(8, 10)?, num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    let ms = match s.get(19..s.len() - 1)? {
        "" => 0,
        frac => {
            let digits = frac.strip_prefix('.').filter(|d| !d.is_empty() && d.bytes().all(|c| c.is_ascii_digit()))?;
            digits.chars().chain("00".chars()).take(3).collect::<String>().parse::<i64>().ok()?
        }
    };
    Some(((days_from_civil(y, mo, d) * 24 + h) * 60 + mi) * 60_000 + sec * 1000 + ms)
}

/// Days since 1970-01-01 of a date in the proleptic Gregorian calendar (H. Hinnant's algorithm).
pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-11-08T10:00:00.000Z
    const T: i64 = 1_794_132_000_000;

    fn ev(e: WorkerEvent) -> Input {
        Input::Event(e)
    }

    fn job(id: &str, title: &str) -> WorkerEvent {
        WorkerEvent::Job {
            id: id.into(),
            attempt: 1,
            attachment: Attachment { kind: "audio".into(), duration_ms: Some(161_000), size: 32_044, file_name: "voice.wav".into() },
            report: ReportRef { id: "r1".into(), project: "demo".into(), title: title.into() },
            report_url: "https://tabula.example.com/#/reports/r1?project=demo".into(),
        }
    }

    fn queue(queued: u32, seen: Option<&str>) -> Input {
        Input::Queue(QueueResult::Ok { queued, running: 0, worker_last_seen: seen.map(String::from) })
    }

    fn unknown(message: &str) -> Input {
        Input::Queue(QueueResult::Failed { message: message.into() })
    }

    /// The tray's own worker, up and waiting for jobs.
    fn running() -> Model {
        let mut m = Model::new();
        assert_eq!(m.apply(Input::Start { once: false }, T), vec![Effect::Spawn { once: false }]);
        m.apply(ev(WorkerEvent::Started { version: "1.3.0".into(), once: false, server: "https://tabula.example.com".into() }), T);
        m.apply(ev(WorkerEvent::Idle), T);
        m
    }

    fn texts(m: &Model) -> Vec<String> {
        m.snapshot().log.into_iter().map(|l| l.text).collect()
    }

    fn notifications(m: &mut Model, input: Input) -> usize {
        m.apply(input, T).into_iter().filter(|e| matches!(e, Effect::Notify { .. })).count()
    }

    #[test]
    fn checks_the_queue_at_most_once_at_a_time() {
        let mut m = Model::new();
        assert_eq!(m.apply(Input::QueueTick, T), vec![Effect::CheckQueue]);
        assert_eq!(m.apply(Input::QueueTick, T), vec![]);
        assert_eq!(m.apply(queue(0, None), T), vec![Effect::CheckQueue]); // the tick that came meanwhile
        assert_eq!(m.apply(queue(0, None), T), vec![]);
    }

    #[test]
    fn stopped_is_grey_and_waiting_recordings_show_the_dot() {
        let mut m = Model::new();
        assert_eq!((m.icon(), m.tooltip()), (Icon::Stopped, "Tabula worker: stopped".to_string()));
        assert_eq!(m.status_line(), "checking the queue · worker stopped");
        m.apply(queue(2, None), T);
        assert_eq!((m.icon(), m.tooltip()), (Icon::Waiting, "2 recordings waiting".to_string()));
        assert_eq!(m.status_line(), "2 waiting · worker stopped");
        m.apply(queue(1, None), T);
        assert_eq!(m.tooltip(), "1 recording waiting");
        m.apply(queue(0, None), T);
        assert_eq!((m.icon(), m.status_line()), (Icon::Stopped, "nothing waiting · worker stopped".to_string()));
        assert_eq!(m.snapshot().queue, QueueView { text: "0 waiting · 0 being transcribed".into(), error: false, checked_at_ms: Some(T) });
    }

    #[test]
    fn an_unknown_queue_is_red_only_while_the_worker_is_stopped() {
        let mut m = Model::new();
        m.apply(unknown("no worker token: run tabula worker setup"), T);
        assert_eq!((m.icon(), m.tooltip()), (Icon::Error, "no worker token: run tabula worker setup".to_string()));
        assert!(m.snapshot().queue.error);
        let mut r = running();
        r.apply(unknown("cannot reach the server"), T);
        assert_eq!(r.icon(), Icon::Idle);
    }

    #[test]
    fn a_job_runs_from_download_to_done() {
        let mut m = running();
        assert_eq!((m.icon(), m.tooltip()), (Icon::Idle, "Waiting for jobs".to_string()));
        m.apply(ev(job("j1", "Player freezes")), T);
        assert_eq!((m.icon(), m.tooltip()), (Icon::Busy, "Starting the job – demo: Player freezes".to_string()));
        m.apply(ev(WorkerEvent::Phase { id: "j1".into(), phase: JobPhase::Download }), T);
        assert_eq!(m.tooltip(), "Downloading – demo: Player freezes");
        m.apply(ev(WorkerEvent::Phase { id: "j1".into(), phase: JobPhase::Transcribe }), T);
        m.apply(ev(WorkerEvent::Progress { id: "j1".into(), done_ms: 67_620, total_ms: Some(161_000) }), T);
        assert_eq!(m.tooltip(), "Transcribing 42 % – demo: Player freezes");
        assert_eq!(m.status_line(), "checking the queue · transcribing 42 %");
        let view = m.snapshot().job.expect("a job");
        assert_eq!((view.recording.as_str(), view.step.as_str(), view.percent), ("Voice note · 2:41", "Transcribing", Some(42)));
        assert_eq!(view.report_url, "https://tabula.example.com/#/reports/r1?project=demo");
        // Progress of another job (a stale line) changes nothing.
        m.apply(ev(WorkerEvent::Progress { id: "other".into(), done_ms: 1, total_ms: Some(2) }), T);
        assert_eq!(m.snapshot().job.unwrap().percent, Some(42));
        assert_eq!(m.apply(ev(WorkerEvent::Done { id: "j1".into(), segments: 2 }), T), vec![Effect::CheckQueue]);
        assert_eq!(m.icon(), Icon::Idle);
        assert!(texts(&m).contains(&"Transcribed demo: Player freezes (2 segments)".to_string()));
    }

    #[test]
    fn a_failed_job_is_logged_as_an_error_and_checks_the_queue() {
        let mut m = running();
        m.apply(ev(job("j1", "Player freezes")), T);
        let fx = m.apply(
            ev(WorkerEvent::Failed { id: "j1".into(), message: "transcription failed (exit 1): boom".into(), retry_at: Some("2026-11-08T10:01:00.000Z".into()) }),
            T,
        );
        assert_eq!(fx, vec![Effect::CheckQueue]);
        let last = m.snapshot().log.pop().unwrap();
        assert_eq!(last.text, "Failed demo: Player freezes: transcription failed (exit 1): boom (the server offers it again later)");
        assert!(last.error);
        assert_eq!(m.icon(), Icon::Idle);
    }

    #[test]
    fn stop_gives_the_job_back_and_a_second_stop_ends_the_worker_at_once() {
        let mut m = running();
        m.apply(ev(job("j1", "Player freezes")), T);
        assert_eq!(m.apply(Input::Stop, T), vec![Effect::SendStop]);
        assert_eq!(m.worker(), &WorkerState::Stopping);
        let s = m.snapshot();
        assert!(s.can_stop && !s.can_start);
        assert_eq!((s.stop_label.as_str(), s.tooltip.as_str()), ("Stop now", "Stopping the worker…"));
        assert_eq!(m.apply(Input::Stop, T), vec![Effect::SendStop]);
        assert_eq!(m.apply(Input::Stop, T), vec![]);
        assert!(!m.snapshot().can_stop);
        m.apply(Input::Exited { code: Some(130) }, T);
        assert_eq!(m.worker(), &WorkerState::Stopped);
        assert!(texts(&m).last().unwrap().contains("lease runs out"));
    }

    #[test]
    fn a_graceful_stop_ends_stopped() {
        let mut m = running();
        m.apply(ev(job("j1", "Player freezes")), T);
        m.apply(Input::Stop, T);
        // An idle event while stopping does not leave Stopping.
        m.apply(ev(WorkerEvent::Idle), T);
        assert_eq!(m.worker(), &WorkerState::Stopping);
        assert_eq!(m.apply(ev(WorkerEvent::Released { id: "j1".into() }), T), vec![Effect::CheckQueue]);
        m.apply(ev(WorkerEvent::Stopped { done: 0, failed: 0, code: 0 }), T);
        m.apply(Input::Exited { code: Some(0) }, T);
        assert_eq!(m.worker(), &WorkerState::Stopped);
        let s = m.snapshot();
        assert!(s.can_start && !s.can_stop && s.can_doctor);
        assert_eq!(s.headline, "Worker stopped");
    }

    #[test]
    fn an_exit_after_an_error_event_shows_that_error() {
        let mut m = running();
        m.apply(ev(WorkerEvent::Error { kind: ErrorKind::Environment, message: "CUDA is not available\nsecond line".into() }), T);
        m.apply(ev(WorkerEvent::Stopped { done: 0, failed: 0, code: 1 }), T);
        m.apply(Input::Exited { code: Some(1) }, T);
        assert_eq!(m.worker(), &WorkerState::Error { kind: Some(ErrorKind::Environment), message: "CUDA is not available\nsecond line".into() });
        assert_eq!((m.icon(), m.tooltip()), (Icon::Error, "CUDA is not available".to_string()));
        assert!(m.snapshot().can_start);
    }

    #[test]
    fn an_exit_without_stopped_names_the_last_lines_or_the_exit_code() {
        let mut m = running();
        for text in ["one", "two", "three"] {
            m.apply(ev(WorkerEvent::Log { text: text.into() }), T);
        }
        m.apply(Input::Stderr("Error: boom".into()), T);
        m.apply(Input::Exited { code: Some(1) }, T);
        assert_eq!(m.worker(), &WorkerState::Error { kind: None, message: "two | three | Error: boom".into() });

        let mut quiet = running();
        quiet.apply(Input::Exited { code: Some(0) }, T); // exit 0, but without "stopped"
        assert_eq!(quiet.worker(), &WorkerState::Error { kind: None, message: "the worker ended with exit code 0".into() });
        let mut killed = running();
        killed.apply(Input::Exited { code: None }, T);
        assert_eq!(killed.worker(), &WorkerState::Error { kind: None, message: "the worker ended unexpectedly".into() });
    }

    #[test]
    fn an_old_cli_is_told_to_update() {
        let mut m = Model::new();
        m.apply(Input::Start { once: true }, T);
        m.apply(Input::Stderr("tabula: tabula worker does not take --events".into()), T);
        m.apply(Input::Exited { code: Some(1) }, T);
        assert_eq!(m.worker(), &WorkerState::Error { kind: None, message: OLD_CLI.into() });
        // A CLI from before tabula worker existed.
        let mut older = Model::new();
        older.apply(Input::Start { once: false }, T);
        older.apply(Input::Stderr("tabula: unknown command \"worker\"; run tabula help".into()), T);
        older.apply(Input::Exited { code: Some(1) }, T);
        assert_eq!(older.worker(), &WorkerState::Error { kind: None, message: OLD_CLI.into() });
    }

    #[test]
    fn a_failed_start_is_an_error_that_can_be_retried() {
        let mut m = Model::new();
        m.apply(Input::Start { once: true }, T);
        let message = "Node.js was not found (node): install Node.js 22 or newer, or set \"node\" in tray.json";
        m.apply(Input::SpawnFailed { message: message.into() }, T);
        assert_eq!(m.worker(), &WorkerState::Error { kind: None, message: message.into() });
        assert!(m.snapshot().can_start);
        assert_eq!(m.apply(Input::Start { once: true }, T), vec![Effect::Spawn { once: true }]);
    }

    #[test]
    fn a_worker_seen_recently_without_the_tray_is_external() {
        let mut m = Model::new();
        m.apply(queue(0, Some("2026-11-08T09:59:30.000Z")), T); // 30 s ago
        assert_eq!(m.worker(), &WorkerState::External);
        assert_eq!((m.icon(), m.tooltip()), (Icon::Idle, "Running outside the tray".to_string()));
        let s = m.snapshot();
        assert!(!s.can_start && !s.can_stop && !s.can_doctor);
        assert_eq!(m.apply(Input::Start { once: false }, T), vec![]);
        m.apply(queue(0, Some("2026-11-08T09:59:30.000Z")), T + 61_000); // 91 s ago
        assert_eq!(m.worker(), &WorkerState::Stopped);
        m.apply(queue(0, Some("2026-11-08T10:01:00.000Z")), T + 61_000);
        assert_eq!(m.worker(), &WorkerState::External);
        m.apply(queue(0, None), T + 61_000);
        assert_eq!(m.worker(), &WorkerState::Stopped);
    }

    #[test]
    fn the_trays_own_last_calls_are_not_an_external_worker() {
        let mut m = running();
        m.apply(Input::Stop, T);
        m.apply(ev(WorkerEvent::Stopped { done: 0, failed: 0, code: 0 }), T);
        m.apply(Input::Exited { code: Some(0) }, T);
        // The server saw the tray's worker a moment ago: its release, a claim it hung up.
        m.apply(queue(0, Some("2026-11-08T09:59:59.000Z")), T + 1_000);
        assert_eq!(m.worker(), &WorkerState::Stopped);
        m.apply(queue(0, Some("2026-11-08T10:00:05.000Z")), T + 6_000); // within the grace: a server clock a little ahead
        assert_eq!(m.worker(), &WorkerState::Stopped);
        m.apply(queue(0, Some("2026-11-08T10:00:20.000Z")), T + 30_000); // a worker started in a terminal later
        assert_eq!(m.worker(), &WorkerState::External);
    }

    #[test]
    fn a_connection_error_keeps_the_worker_running_with_a_note() {
        let mut m = running();
        let message = "cannot reach https://tabula.example.com: ECONNREFUSED";
        m.apply(ev(WorkerEvent::Log { text: format!("{message}; trying again in 2 s") }), T);
        m.apply(ev(WorkerEvent::Error { kind: ErrorKind::Connection, message: message.into() }), T);
        assert_eq!(m.worker(), &WorkerState::Idle);
        assert_eq!(m.snapshot().note.as_deref(), Some(message));
        // The log line that already says it turns red; no second line.
        let log = m.snapshot().log;
        assert!(log.last().unwrap().error && log.last().unwrap().text.ends_with("trying again in 2 s"));
        m.apply(ev(WorkerEvent::Idle), T);
        assert_eq!(m.snapshot().note, None);
    }

    #[test]
    fn notifies_once_per_wave_while_the_worker_is_stopped() {
        let mut m = Model::new();
        // The first check counts as a rise from nothing: something waits when the tray starts.
        assert_eq!(m.apply(queue(1, None), T), vec![Effect::Notify { queued: 1 }]);
        assert_eq!(notifications(&mut m, queue(2, None)), 0);
        assert_eq!(notifications(&mut m, unknown("cannot reach the server")), 0);
        assert_eq!(notifications(&mut m, queue(3, None)), 0, "an unreachable server starts no new wave");
        assert_eq!(notifications(&mut m, queue(0, None)), 0);
        assert_eq!(m.apply(queue(1, None), T), vec![Effect::Notify { queued: 1 }]);
    }

    #[test]
    fn notifies_after_an_error_but_not_while_a_worker_runs() {
        let mut failed = Model::new();
        failed.apply(Input::Start { once: true }, T);
        failed.apply(Input::SpawnFailed { message: "no node".into() }, T);
        assert_eq!(failed.apply(queue(1, None), T), vec![Effect::Notify { queued: 1 }]);
        let mut r = running();
        assert_eq!(r.apply(queue(1, None), T), vec![]);
        let mut outside = Model::new();
        assert_eq!(outside.apply(queue(1, Some("2026-11-08T09:59:50.000Z")), T), vec![]);
        assert_eq!(outside.worker(), &WorkerState::External);
    }

    #[test]
    fn the_tooltip_fits_the_windows_limit() {
        let title = "Prehrávač 🎙️ zamrzne ".repeat(20);
        let mut m = running();
        m.apply(ev(job("j1", &title)), T);
        let tip = m.tooltip();
        assert!(tip.encode_utf16().count() <= TOOLTIP_UNITS, "{} units", tip.encode_utf16().count());
        assert!(tip.ends_with('…'));
        assert!(tip.starts_with("Starting the job – demo: Prehrávač 🎙️ zamrzne"));
        assert_eq!(clip_utf16("short", 127), "short");
        assert_eq!(clip_utf16("ab🎙️cd", 4), "ab…");
    }

    #[test]
    fn the_log_keeps_the_last_200_lines_and_reports_odd_lines() {
        let mut m = running();
        for i in 0..250 {
            m.apply(ev(WorkerEvent::Log { text: format!("line {i}") }), T);
        }
        let log = texts(&m);
        assert_eq!(log.len(), LOG_LINES);
        assert_eq!(log[0], "line 50");
        m.apply(Input::Invalid("not json".into()), T);
        let last = m.snapshot().log.pop().unwrap();
        assert_eq!(last.text, "Ignored a line from the worker that is not an event: not json");
        assert!(last.error);
    }

    #[test]
    fn quit_stops_the_worker_first() {
        let mut stopped = Model::new();
        assert_eq!(stopped.apply(Input::Quit, T), vec![Effect::Exit]);
        let mut m = running();
        assert_eq!(m.apply(Input::Quit, T), vec![Effect::SendStop, Effect::ExitAfterStop]);
        let s = m.snapshot();
        assert!(!s.can_start && !s.can_stop && !s.can_doctor);
        assert_eq!(m.apply(Input::Quit, T), vec![]);
        assert_eq!(m.apply(Input::Stop, T), vec![]);
        let mut stopping = running();
        stopping.apply(Input::Stop, T);
        assert_eq!(stopping.apply(Input::Quit, T), vec![Effect::ExitAfterStop]);
    }

    #[test]
    fn doctor_runs_only_while_no_worker_does() {
        let mut m = Model::new();
        assert_eq!(m.apply(Input::Doctor, T), vec![Effect::RunDoctor]);
        assert!(!m.snapshot().can_start && !m.snapshot().can_doctor);
        assert_eq!(m.apply(Input::Doctor, T), vec![]);
        m.apply(Input::DoctorLine("FAIL  ffmpeg (ffmpeg) does not run".into()), T);
        assert!(m.snapshot().log.last().unwrap().error);
        m.apply(Input::DoctorLine("ok    Python 3.12.7".into()), T);
        assert!(!m.snapshot().log.last().unwrap().error);
        m.apply(Input::DoctorDone { code: Some(1) }, T);
        assert!(m.snapshot().can_start);
        let mut r = running();
        assert_eq!(r.apply(Input::Doctor, T), vec![]);
    }

    #[test]
    fn events_without_a_worker_are_ignored() {
        let mut m = Model::new();
        m.apply(ev(job("j1", "x")), T);
        m.apply(Input::Exited { code: Some(1) }, T);
        assert_eq!(m.worker(), &WorkerState::Stopped);
    }

    #[test]
    fn parses_the_servers_times() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_iso_ms("2026-11-08T10:00:00.000Z"), Some(T));
        assert_eq!(parse_iso_ms("2000-02-29T23:59:59.999Z"), Some(951_868_799_999));
        assert_eq!(parse_iso_ms("1969-12-31T23:59:59Z"), Some(-1_000));
        for bad in ["", "yesterday", "2026-11-08 10:00:00Z", "2026-11-08T10:00:00.000", "2026-13-08T10:00:00.000Z", "2026-11-08T10:00:00.é00Z"] {
            assert_eq!(parse_iso_ms(bad), None, "{bad}");
        }
    }

    #[test]
    fn an_outside_worker_is_dropped_when_the_queue_cannot_be_checked() {
        let mut m = Model::new();
        m.apply(queue(0, Some("2026-11-08T09:59:50.000Z")), T);
        assert_eq!(m.worker(), &WorkerState::External);
        m.apply(unknown("cannot reach the server"), T + 1_000);
        assert_eq!(m.worker(), &WorkerState::Stopped);
        assert_eq!((m.icon(), m.tooltip()), (Icon::Error, "cannot reach the server".to_string()));
        assert!(m.can_start() && m.can_doctor());
    }

    #[test]
    fn a_recovered_connection_error_is_not_blamed_for_a_later_crash() {
        let mut m = running();
        m.apply(ev(WorkerEvent::Error { kind: ErrorKind::Connection, message: "cannot reach the server".into() }), T);
        m.apply(ev(WorkerEvent::Idle), T);
        m.apply(ev(WorkerEvent::Log { text: "segfault".into() }), T);
        m.apply(Input::Exited { code: Some(139) }, T);
        assert_eq!(m.worker(), &WorkerState::Error { kind: None, message: "segfault".into() });
        let mut other = running();
        other.apply(ev(WorkerEvent::Error { kind: ErrorKind::Connection, message: "cannot reach the server".into() }), T);
        other.apply(ev(job("j1", "x")), T);
        other.apply(Input::Exited { code: Some(1) }, T);
        assert_eq!(other.worker(), &WorkerState::Error { kind: None, message: "the worker ended with exit code 1".into() });
    }

    #[test]
    fn the_snapshot_serializes_with_the_names_the_window_reads() {
        let mut m = running();
        m.apply(ev(job("j1", "Player freezes")), T);
        m.apply(queue(2, None), T);
        let v = serde_json::to_value(m.snapshot()).unwrap();
        let keys = |v: &serde_json::Value| {
            let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
            k.sort();
            k
        };
        assert_eq!(
            keys(&v),
            ["canDoctor", "canStart", "canStop", "headline", "icon", "job", "log", "note", "queue", "status", "stopLabel", "tooltip"]
        );
        assert_eq!(keys(&v["job"]), ["percent", "project", "recording", "reportUrl", "step", "title"]);
        assert_eq!(keys(&v["queue"]), ["checkedAtMs", "error", "text"]);
        assert_eq!(keys(&v["log"][0]), ["atMs", "error", "text"]);
        assert_eq!(v["icon"], "busy");
        for (icon, name) in [(Icon::Stopped, "stopped"), (Icon::Waiting, "waiting"), (Icon::Idle, "idle"), (Icon::Busy, "busy"), (Icon::Error, "error")] {
            assert_eq!(serde_json::to_value(icon).unwrap(), name);
        }
    }

    #[test]
    fn clipping_to_a_tiny_limit_does_not_panic() {
        assert_eq!(clip_utf16("abc", 0), "");
        assert_eq!(clip_utf16("abc", 1), "…");
        assert_eq!(clip_utf16("abc", 2), "a…");
        assert_eq!(clip_utf16("", 0), "");
    }

    #[test]
    fn nothing_is_checked_or_notified_while_quitting() {
        let mut m = running();
        m.apply(Input::Quit, T);
        m.apply(Input::Stop, T);
        m.apply(ev(WorkerEvent::Stopped { done: 0, failed: 0, code: 0 }), T);
        assert_eq!(m.apply(Input::Exited { code: Some(0) }, T), vec![]);
        assert_eq!(m.apply(Input::QueueTick, T), vec![]);
        assert_eq!(m.apply(queue(3, None), T), vec![]);
    }

    #[test]
    fn formats_clock_times_like_the_cli() {
        assert_eq!([0, 5_400, 161_999, 3_723_000].map(format_clock), ["0:00", "0:05", "2:41", "1:02:03"]);
    }

    #[test]
    fn opens_only_web_addresses() {
        assert!(is_web_url("https://tabula.example.com/#/reports/r1?project=demo"));
        assert!(is_web_url("http://localhost:3100/"));
        assert!(!is_web_url("file:///etc/passwd"));
        assert!(!is_web_url("C:\\Windows\\notepad.exe"));
    }
}
