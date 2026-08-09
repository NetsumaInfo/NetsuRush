use std::process::{Child, Output};
use std::sync::mpsc;
use std::time::Duration;

/// Outcome of [`wait_with_output_timeout`].
pub(crate) enum WaitOutcome {
    /// Process finished within the deadline; carries its captured output.
    Finished(Output),
    /// The deadline elapsed; the process was killed.
    TimedOut,
    /// Waiting on the process failed (I/O error draining pipes / reaping).
    WaitFailed(std::io::Error),
}

/// Wait for a child process to finish, draining stdout/stderr, with a hard
/// timeout. On timeout the process is killed.
///
/// A dedicated thread owns the `Child` and runs `wait_with_output()` (which
/// drains the pipes to avoid full-pipe deadlock). The caller side performs a
/// single `recv_timeout`. If the timeout elapses, the process is terminated.
pub(crate) fn wait_with_output_timeout(child: Child, timeout: Duration) -> WaitOutcome {
    // Capture the raw handle/pid before moving `child` into the waiter thread,
    // so we can still kill it on timeout.
    #[cfg(target_os = "windows")]
    let kill_handle = {
        use std::os::windows::io::AsRawHandle;
        child.as_raw_handle() as isize
    };
    #[cfg(not(target_os = "windows"))]
    let kill_pid = child.id();

    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        // `wait_with_output` consumes the child and drains both pipes.
        let result = child.wait_with_output();
        let _ = tx.send(result);
    });

    match rx.recv_timeout(timeout) {
        Ok(Ok(output)) => WaitOutcome::Finished(output),
        Ok(Err(e)) => WaitOutcome::WaitFailed(e),
        Err(_) => {
            // Timed out: kill the process. The waiter thread will then observe
            // process exit, finish draining, and send (we no longer read it).
            kill_process(
                #[cfg(target_os = "windows")]
                kill_handle,
                #[cfg(not(target_os = "windows"))]
                kill_pid,
            );
            WaitOutcome::TimedOut
        }
    }
}

#[cfg(target_os = "windows")]
fn kill_process(handle: isize) {
    // `TerminateProcess` is exported by kernel32, which is auto-linked on the
    // MSVC target. No extra crate required.
    extern "system" {
        fn TerminateProcess(hProcess: isize, uExitCode: u32) -> i32;
    }
    if handle != 0 {
        unsafe {
            let _ = TerminateProcess(handle, 1);
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn kill_process(pid: u32) {
    // Best-effort SIGKILL via the libc `kill` symbol (auto-linked). The child is
    // owned by the waiter thread, so we cannot call `child.kill()` here.
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    const SIGKILL: i32 = 9;
    unsafe {
        let _ = kill(pid as i32, SIGKILL);
    }
}
