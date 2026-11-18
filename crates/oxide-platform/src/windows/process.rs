//! Process supervision on Windows: Job Objects instead of process groups.

use crate::ProcessIdentity;
use std::io;
use std::process::Command;
use std::time::Duration;
use windows_sys::Win32::System::Threading::{
    CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, CREATE_SUSPENDED,
};

/// Background CLI calls must not create a visible console in the Windows app.
pub fn hide_console(command: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

/// Makes `command` start suspended in a new process group, so it can be put in its job before it
/// runs. Windows stdio children run without a console window; PTY shells own their console.
pub fn spawn_in_own_group(command: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_SUSPENDED | CREATE_NO_WINDOW);
    command
}

/// Print mode has no input channel, so interrupting ends the whole contained process tree.
pub fn interrupt_group(pgid: i32) -> io::Result<()> {
    terminate_group(pgid, Duration::ZERO, || {});
    Ok(())
}

/// Ends the job of `pgid` at once without waiting for it; used when its stdout turned hostile.
pub fn kill_group(pgid: i32) {
    terminate_group(pgid, Duration::ZERO, || {});
}

/// Whether any process of the job of `pgid` still exists.
pub fn group_alive(pgid: i32) -> bool {
    job::group_alive(pgid)
}

/// Whether the single process `pid` still exists.
pub fn process_alive(pid: i32) -> bool {
    job::group_alive(pid)
}

/// Terminates the job of `pgid`, then waits up to five seconds for it to empty. `reap` runs on
/// every poll so the caller can `wait` on the leader. The grace period is not used: a Job Object
/// has no gentler signal than termination.
pub fn terminate_group(pgid: i32, _grace: Duration, mut reap: impl FnMut()) {
    job::terminate_group(pgid);
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        reap();
        if !group_alive(pgid) || std::time::Instant::now() >= deadline {
            job::close_job(pgid);
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Attach a spawned child to a kill-on-close Job Object. Descendants inherit the job, so closing
/// Oxide or terminating the leader also terminates its process tree.
pub fn attach_to_job(pid: u32) -> io::Result<()> {
    job::attach(pid as i32, true)
}

/// Attach an already running child, such as a PTY shell, to a Job Object.
pub fn attach_running_to_job(pid: u32) -> io::Result<()> {
    job::attach(pid as i32, false)
}

/// Releases the process job after a child has exited.
pub fn release_job(pid: i32) {
    job::close_job(pid);
}

/// The image a process runs and when it started, which tell a reused pid from the original.
pub fn process_identity(pid: i32) -> Option<ProcessIdentity> {
    job::process_identity(pid)
}

/// Whether `pid` is the process Oxide recorded: same start time and image when an identity was
/// recorded, else the same executable name.
pub fn leader_runs(pid: i32, executable: &str, identity: Option<&ProcessIdentity>) -> bool {
    job::leader_runs(pid, executable, identity)
}

mod job {
    use crate::ProcessIdentity;
    use crate::sync::LockExt as _;
    use std::collections::HashMap;
    use std::collections::HashSet;
    use std::io;
    use std::mem::{size_of, zeroed};
    use std::ptr::{null, null_mut};
    use std::sync::{Mutex, OnceLock};
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
    };
    use windows_sys::Win32::System::JobObjects::IsProcessInJob;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
        QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, OpenThread, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SET_QUOTA, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, QueryFullProcessImageNameW,
        ResumeThread, THREAD_SUSPEND_RESUME, WaitForSingleObject,
    };

    static JOBS: OnceLock<Mutex<HashMap<i32, usize>>> = OnceLock::new();

    fn jobs() -> &'static Mutex<HashMap<i32, usize>> {
        JOBS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    pub(super) fn attach(pid: i32, resume_suspended: bool) -> io::Result<()> {
        if pid <= 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid process id",
            ));
        }
        if jobs().lock_recover().contains_key(&pid) {
            return Ok(());
        }
        // SAFETY: every Win32 call in this block gets a handle created here, is checked for
        // null or failure before use, and the handles are closed on every exit path. The zeroed
        // limits struct is plain C data that is fully initialised before it is passed in.
        unsafe {
            let job = CreateJobObjectW(null(), null());
            if job.is_null() {
                return Err(io::Error::last_os_error());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                let error = io::Error::last_os_error();
                CloseHandle(job);
                return Err(error);
            }
            let process = OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid as u32,
            );
            if process.is_null() {
                let error = io::Error::last_os_error();
                CloseHandle(job);
                return Err(error);
            }
            let assigned = AssignProcessToJobObject(job, process) != 0;
            let error = (!assigned).then(io::Error::last_os_error);
            CloseHandle(process);
            if let Some(error) = error {
                CloseHandle(job);
                return Err(error);
            }
            if resume_suspended {
                if let Err(error) = resume_primary_thread(pid as u32) {
                    CloseHandle(job);
                    return Err(error);
                }
            } else if let Err(error) = attach_existing_descendants(pid as u32, job) {
                CloseHandle(job);
                return Err(error);
            }
            let old = jobs().lock_recover().insert(pid, job as usize);
            if let Some(old) = old {
                CloseHandle(old as HANDLE);
            }
            Ok(())
        }
    }

    /// # Safety
    ///
    /// `job` must be a live job object handle.
    unsafe fn attach_existing_descendants(root_pid: u32, job: HANDLE) -> io::Result<()> {
        let mut attached = HashSet::from([root_pid]);
        loop {
            // SAFETY: plain flags and a pid; the snapshot handle is checked before use.
            let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
            if snapshot == -1_isize as HANDLE {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: `PROCESSENTRY32W` is plain C data for which all-zero is valid.
            let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
            entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
            let mut parents = Vec::new();
            // SAFETY: `snapshot` is a valid handle and `entry.dwSize` is set, as the API requires.
            let mut found = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
            while found {
                parents.push((entry.th32ProcessID, entry.th32ParentProcessID));
                // SAFETY: same as above.
                found = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
            }
            // SAFETY: `snapshot` is a valid handle that is closed exactly once.
            unsafe { CloseHandle(snapshot) };

            let mut descendants = HashSet::new();
            loop {
                let before = descendants.len();
                for &(pid, parent) in &parents {
                    if parent == root_pid || descendants.contains(&parent) {
                        descendants.insert(pid);
                    }
                }
                if descendants.len() == before {
                    break;
                }
            }
            let mut added = false;
            for pid in descendants
                .difference(&attached)
                .copied()
                .collect::<Vec<_>>()
            {
                attached.insert(pid);
                // SAFETY: `OpenProcess` takes plain values; a null result is handled below.
                let process = unsafe {
                    OpenProcess(
                        PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                        0,
                        pid,
                    )
                };
                if process.is_null() {
                    continue;
                }
                let mut already_in_job = 0;
                // SAFETY: `process` is a valid, non-null handle and `job` is the caller's live job.
                let checked = unsafe { IsProcessInJob(process, job, &mut already_in_job) } != 0;
                let assigned = checked
                    && (already_in_job != 0
                        // SAFETY: same handles as the check above.
                        || unsafe { AssignProcessToJobObject(job, process) } != 0);
                // SAFETY: `process` is a valid handle that is closed exactly once.
                unsafe { CloseHandle(process) };
                added |= assigned;
            }
            if !added {
                return Ok(());
            }
        }
    }

    /// # Safety
    ///
    /// `pid` must name a process created suspended by this module.
    unsafe fn resume_primary_thread(pid: u32) -> io::Result<()> {
        // SAFETY: plain flags and a pid; the snapshot handle is checked before use.
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == -1_isize as HANDLE {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `THREADENTRY32` is plain C data for which all-zero is valid.
        let mut entry: THREADENTRY32 = unsafe { zeroed() };
        entry.dwSize = size_of::<THREADENTRY32>() as u32;
        let mut thread_id = None;
        // SAFETY: `snapshot` is a valid handle and `entry.dwSize` is set, as the API requires.
        let mut found = unsafe { Thread32First(snapshot, &mut entry) } != 0;
        while found {
            if entry.th32OwnerProcessID == pid {
                thread_id = Some(entry.th32ThreadID);
                break;
            }
            // SAFETY: same as above.
            found = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
        }
        // SAFETY: `snapshot` is a valid handle that is closed exactly once.
        unsafe { CloseHandle(snapshot) };
        let Some(thread_id) = thread_id else {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "suspended process thread was not found",
            ));
        };
        // SAFETY: `OpenThread` takes plain values; a null result is handled just below.
        let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, thread_id) };
        if thread.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `thread` is a valid, non-null handle.
        let resumed = unsafe { ResumeThread(thread) } != u32::MAX;
        let error = (!resumed).then(io::Error::last_os_error);
        // SAFETY: `thread` is a valid handle that is closed exactly once.
        unsafe { CloseHandle(thread) };
        error.map_or(Ok(()), Err)
    }

    pub(super) fn group_alive(pid: i32) -> bool {
        if pid <= 0 {
            return false;
        }
        let jobs = jobs().lock_recover();
        if let Some(&job) = jobs.get(&pid) {
            let job = job as HANDLE;
            // SAFETY: `job` is a live job handle owned by the registry (guarded by the lock held
            // here), and the zeroed accounting struct is plain C data the call fills in.
            unsafe {
                let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = zeroed();
                return QueryInformationJobObject(
                    job,
                    JobObjectBasicAccountingInformation,
                    &mut accounting as *mut _ as *mut _,
                    size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    null_mut(),
                ) != 0
                    && accounting.ActiveProcesses != 0;
            }
        }
        // SAFETY: `OpenProcess` takes plain values; the handle is checked for null and closed
        // once.
        unsafe {
            let process = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid as u32);
            if process.is_null() {
                return false;
            }
            let alive = WaitForSingleObject(process, 0) == WAIT_TIMEOUT;
            CloseHandle(process);
            alive
        }
    }

    pub(super) fn terminate_group(pid: i32) {
        if pid <= 0 {
            return;
        }
        let job = jobs().lock_recover().get(&pid).copied();
        if let Some(job) = job {
            let job = job as HANDLE;
            // SAFETY: `job` is a live job handle owned by the registry.
            unsafe { TerminateJobObject(job, 1) };
            return;
        }
        // SAFETY: `OpenProcess` takes plain values; the handle is checked for null and closed
        // once.
        unsafe {
            let process = OpenProcess(PROCESS_TERMINATE, 0, pid as u32);
            if !process.is_null() {
                windows_sys::Win32::System::Threading::TerminateProcess(process, 1);
                CloseHandle(process);
            }
        }
    }

    pub(super) fn close_job(pid: i32) {
        if let Some(job) = jobs().lock_recover().remove(&pid) {
            // SAFETY: the handle was just removed from the registry, so this is its only close.
            unsafe { CloseHandle(job as HANDLE) };
        }
    }

    pub(super) fn leader_runs(
        pid: i32,
        executable: &str,
        identity: Option<&ProcessIdentity>,
    ) -> bool {
        if pid <= 0 {
            return false;
        }
        let Some(actual_identity) = process_identity(pid) else {
            return false;
        };
        if identity.is_some_and(|identity| identity.creation_time != actual_identity.creation_time)
        {
            return false;
        }
        if let Some(identity) = identity {
            return identity.image.eq_ignore_ascii_case(&actual_identity.image);
        }
        let actual_name = actual_identity
            .image
            .rsplit(['\\', '/'])
            .next()
            .unwrap_or(&actual_identity.image);
        let wanted = executable.rsplit(['\\', '/']).next().unwrap_or(executable);
        actual_name.eq_ignore_ascii_case(wanted)
    }

    pub(super) fn process_identity(pid: i32) -> Option<ProcessIdentity> {
        if pid <= 0 {
            return None;
        }
        // SAFETY: the handle is checked for null and closed once; the buffers outlive the calls
        // and `length` holds the buffer size in characters, as the API requires.
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32);
            if process.is_null() {
                return None;
            }
            let mut image = vec![0u16; 32_768];
            let mut length = image.len() as u32;
            let image_ok =
                QueryFullProcessImageNameW(process, 0, image.as_mut_ptr(), &mut length) != 0;
            let mut created = zeroed();
            let mut exited = zeroed();
            let mut kernel = zeroed();
            let mut user = zeroed();
            let times_ok =
                GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) != 0;
            CloseHandle(process);
            if !image_ok || !times_ok {
                return None;
            }
            let created: windows_sys::Win32::Foundation::FILETIME = created;
            let created = ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64;
            Some(ProcessIdentity {
                image: String::from_utf16_lossy(&image[..length as usize]),
                creation_time: created,
            })
        }
    }
}
