//! A tray started by the Windows Installer inherits its Redirection Guard (the process mitigation
//! `ProcessRedirectionTrustPolicy`), and so do the worker, node and ffmpeg it starts. Such a process does not follow
//! folder links (junctions) made by a user, which is how scoop installs every program. So the tray starts itself
//! again through Explorer, which does not pass the mitigation on, and the first one exits. A stamp in the data folder
//! keeps a tray that gets the policy anyway (a policy for the whole system) from starting itself again and again.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The time of the last relaunch, in `<data>`.
pub const STAMP: &str = "tray-relaunch.stamp";

/// A relaunch younger than this means the relaunched tray has the policy as well: it does not relaunch again.
pub const GUARD: Duration = Duration::from_secs(60);

/// The window's log line when the tray runs with the policy.
pub const WARNING: &str = "Windows protects this tray against folder links (Redirection Guard), so programs installed through \
links (e.g. scoop) may not start; quit the tray and start it from the Start menu.";

/// How `main` goes on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Start {
    /// No Redirection Guard: start as usual.
    Normal,
    /// Another tray is starting through Explorer: exit at once.
    Relaunched,
    /// Redirection Guard, but no relaunch (a fresh stamp, or it failed): start, and say so in the window's log.
    Guarded,
}

/// What to do at the very start of `main`: relaunch through Explorer if the tray runs with Redirection Guard.
pub fn check(data: &Path) -> Start {
    if !redirection_trust_enforced() {
        return Start::Normal;
    }
    let stamp = data.join(STAMP);
    let now = SystemTime::now();
    // Without a stamp a tray that keeps the policy would relaunch itself again and again.
    if !should_relaunch(true, read_stamp(&stamp), now) || write_stamp(&stamp, now).is_err() {
        return Start::Guarded;
    }
    match relaunch_through_explorer() {
        Ok(()) => Start::Relaunched,
        Err(_) => Start::Guarded,
    }
}

/// Relaunch when the policy is enforced and no relaunch happened in the last [`GUARD`]. A stamp from the future (the
/// clock was set back) counts as old.
pub fn should_relaunch(enforced: bool, last_relaunch: Option<SystemTime>, now: SystemTime) -> bool {
    enforced
        && match last_relaunch.map(|last| now.duration_since(last)) {
            None => true,
            Some(Ok(age)) => age >= GUARD,
            Some(Err(_)) => true,
        }
}

/// The stamp's time; None when there is none or it cannot be read.
pub fn read_stamp(file: &Path) -> Option<SystemTime> {
    let ms = std::fs::read_to_string(file).ok()?.trim().parse::<u64>().ok()?;
    UNIX_EPOCH.checked_add(Duration::from_millis(ms))
}

/// Writes the stamp (milliseconds since 1970), creating its folder.
pub fn write_stamp(file: &Path, at: SystemTime) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let ms = at.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    std::fs::write(file, ms.to_string())
}

/// Starts this exe again through Explorer: the shell starts it, without the mitigations of this process. Explorer
/// passes no arguments, so the new tray shows its window, as a start by hand does.
fn relaunch_through_explorer() -> std::io::Result<()> {
    let exe: PathBuf = std::env::current_exe()?;
    std::process::Command::new("explorer.exe").arg(exe).spawn().map(drop)
}

/// Whether this process has `ProcessRedirectionTrustPolicy` with `EnforceRedirectionTrust` (bit 0); a failed read
/// counts as not enforced.
#[cfg(windows)]
fn redirection_trust_enforced() -> bool {
    use windows_sys::Win32::System::SystemServices::PROCESS_MITIGATION_REDIRECTION_TRUST_POLICY;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessMitigationPolicy, ProcessRedirectionTrustPolicy};
    let mut policy = PROCESS_MITIGATION_REDIRECTION_TRUST_POLICY::default();
    // SAFETY: the buffer is the policy's own struct, with its size; GetCurrentProcess is a pseudo handle that needs no
    // closing.
    let ok = unsafe {
        GetProcessMitigationPolicy(
            GetCurrentProcess(),
            ProcessRedirectionTrustPolicy,
            (&raw mut policy).cast(),
            std::mem::size_of::<PROCESS_MITIGATION_REDIRECTION_TRUST_POLICY>(),
        )
    };
    // SAFETY: both fields of the union are a u32.
    ok != 0 && unsafe { policy.Anonymous.Flags } & 1 != 0
}

#[cfg(not(windows))]
fn redirection_trust_enforced() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    fn temp() -> PathBuf {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!("tabula tray relaunch é {}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn relaunches_only_with_the_policy_and_no_recent_relaunch() {
        let now = UNIX_EPOCH + Duration::from_secs(1_800_000_000);
        assert!(!should_relaunch(false, None, now), "not enforced");
        assert!(!should_relaunch(false, Some(now - Duration::from_secs(3600)), now), "not enforced, old stamp");
        assert!(should_relaunch(true, None, now), "enforced, no stamp");
        assert!(!should_relaunch(true, Some(now - Duration::from_secs(5)), now), "enforced, fresh stamp");
        assert!(!should_relaunch(true, Some(now), now), "enforced, stamp of this very moment");
        assert!(should_relaunch(true, Some(now - GUARD), now), "enforced, stamp exactly 60 s old");
        assert!(should_relaunch(true, Some(now - Duration::from_secs(3600)), now), "enforced, old stamp");
        assert!(should_relaunch(true, Some(now + Duration::from_secs(3600)), now), "enforced, stamp from the future");
    }

    #[test]
    fn the_stamp_keeps_the_time_and_creates_its_folder() {
        let file = temp().join("data").join(STAMP);
        assert_eq!(read_stamp(&file), None);
        let at = UNIX_EPOCH + Duration::from_millis(1_800_000_000_123);
        write_stamp(&file, at).unwrap();
        assert_eq!(read_stamp(&file), Some(at));
        let later = at + Duration::from_secs(90);
        write_stamp(&file, later).unwrap();
        assert_eq!(read_stamp(&file), Some(later));
    }

    #[test]
    fn a_broken_stamp_counts_as_none() {
        let dir = temp();
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join(STAMP);
        fs::write(&file, "yesterday").unwrap();
        assert_eq!(read_stamp(&file), None);
    }
}
