#![allow(dead_code)]
use libloading::Library;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_double, c_int, c_void};
use std::ptr;

// mpv format constants
pub const MPV_FORMAT_NONE: c_int = 0;
pub const MPV_FORMAT_STRING: c_int = 1;
pub const MPV_FORMAT_FLAG: c_int = 3;
pub const MPV_FORMAT_INT64: c_int = 4;
pub const MPV_FORMAT_DOUBLE: c_int = 5;

// mpv event IDs
pub const MPV_EVENT_NONE: c_int = 0;
pub const MPV_EVENT_SHUTDOWN: c_int = 1;
pub const MPV_EVENT_FILE_LOADED: c_int = 8;
pub const MPV_EVENT_PROPERTY_CHANGE: c_int = 22;

#[repr(C)]
pub struct MpvEvent {
    pub event_id: c_int,
    pub error: c_int,
    pub reply_userdata: u64,
    pub data: *mut c_void,
}

#[repr(C)]
pub struct MpvEventProperty {
    pub name: *const c_char,
    pub format: c_int,
    pub data: *mut c_void,
}

pub type MpvHandle = *mut c_void;

#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
extern "system" {
    fn SetDllDirectoryW(path: *const u16) -> i32;
}

/// Add `dir` to the process DLL search path so a dynamically-loaded library can
/// resolve its sibling dependencies from that folder.
#[cfg(target_os = "windows")]
fn add_dll_search_dir(dir: &std::path::Path) {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = dir
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        SetDllDirectoryW(wide.as_ptr());
    }
}

/// Restore the default DLL search path.
#[cfg(target_os = "windows")]
fn clear_dll_search_dir() {
    unsafe {
        SetDllDirectoryW(ptr::null());
    }
}

#[cfg(not(target_os = "windows"))]
fn add_dll_search_dir(_dir: &std::path::Path) {}
#[cfg(not(target_os = "windows"))]
fn clear_dll_search_dir() {}

pub struct MpvLib {
    _lib: Library,
    pub create: unsafe fn() -> MpvHandle,
    pub initialize: unsafe fn(MpvHandle) -> c_int,
    pub terminate_destroy: unsafe fn(MpvHandle),
    pub command: unsafe fn(MpvHandle, *const *const c_char) -> c_int,
    pub command_string: unsafe fn(MpvHandle, *const c_char) -> c_int,
    pub set_option_string: unsafe fn(MpvHandle, *const c_char, *const c_char) -> c_int,
    pub get_property_string: unsafe fn(MpvHandle, *const c_char) -> *mut c_char,
    pub set_property_string: unsafe fn(MpvHandle, *const c_char, *const c_char) -> c_int,
    pub set_property: unsafe fn(MpvHandle, *const c_char, c_int, *mut c_void) -> c_int,
    pub get_property: unsafe fn(MpvHandle, *const c_char, c_int, *mut c_void) -> c_int,
    pub observe_property: unsafe fn(MpvHandle, u64, *const c_char, c_int) -> c_int,
    pub wait_event: unsafe fn(MpvHandle, c_double) -> *mut MpvEvent,
    pub free: unsafe fn(*mut c_void),
}

impl MpvLib {
    pub fn load() -> Result<Self, String> {
        // Try multiple possible locations for mpv DLL
        let lib_names = vec!["mpv-2.dll", "libmpv-2.dll", "mpv-1.dll"];

        let mut last_error = String::new();
        let mut search_dirs: Vec<std::path::PathBuf> = Vec::new();

        // 1. Current working directory
        if let Ok(cwd) = std::env::current_dir() {
            search_dirs.push(cwd.clone());
            search_dirs.push(cwd.join("src-tauri").join("resources").join("windows"));
            // Also parent of CWD (if CWD is src-tauri, parent is project root)
            if let Some(parent) = cwd.parent() {
                search_dirs.push(parent.to_path_buf());
                search_dirs.push(parent.join("src-tauri").join("resources").join("windows"));
            }
        }

        // 2. Exe directory and ancestors (handles target/debug layout)
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                search_dirs.push(exe_dir.to_path_buf());
                search_dirs.push(exe_dir.join("resources"));
                search_dirs.push(exe_dir.join("resources").join("windows"));
                // Walk up from exe dir to find project root
                // In dev: exe is at src-tauri/target/debug/ -> go up 3 levels
                let mut ancestor = exe_dir.to_path_buf();
                for _ in 0..5 {
                    if let Some(parent) = ancestor.parent() {
                        ancestor = parent.to_path_buf();
                        search_dirs.push(ancestor.clone());
                    }
                }
            }
        }

        search_dirs.push(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("windows"));

        // Try system search first (PATH, system dirs)
        for name in &lib_names {
            match unsafe { Library::new(name) } {
                Ok(lib) => return Self::load_from_library(lib),
                Err(e) => {
                    last_error = format!("System: {}", e);
                }
            }
        }

        // Try each search directory with each library name
        for dir in &search_dirs {
            for name in &lib_names {
                let full_path = dir.join(name);
                if full_path.exists() {
                    eprintln!("[mpv] Trying: {}", full_path.display());
                    // The stripped libmpv is a *shared* build: it imports avcodec/
                    // avformat/libplacebo/etc. that ship next to it. `Library::new`
                    // loads with default flags, so Windows resolves those deps from
                    // the exe dir — not libmpv's folder. Add that folder to the DLL
                    // search path so the siblings are found.
                    add_dll_search_dir(dir);
                    let result = unsafe { Library::new(&full_path) };
                    clear_dll_search_dir();
                    match result {
                        Ok(lib) => {
                            eprintln!("[mpv] Loaded from: {}", full_path.display());
                            return Self::load_from_library(lib);
                        }
                        Err(e) => {
                            last_error = format!("{}: {}", full_path.display(), e);
                        }
                    }
                }
            }
        }

        // Log all searched paths for debugging
        let searched: Vec<String> = search_dirs
            .iter()
            .map(|d| d.display().to_string())
            .collect();
        Err(format!(
            "mpv library not found. Place libmpv-2.dll in src-tauri/resources/windows. Searched: [{}]. Last error: {}",
            searched.join(", "),
            last_error
        ))
    }

    fn load_from_library(lib: Library) -> Result<Self, String> {
        unsafe {
            // Extract raw function pointers before moving lib
            let create_ptr = *lib
                .get::<unsafe fn() -> MpvHandle>(b"mpv_create\0")
                .map_err(|e| format!("Failed to load mpv_create: {}", e))?;
            let initialize_ptr = *lib
                .get::<unsafe fn(MpvHandle) -> c_int>(b"mpv_initialize\0")
                .map_err(|e| format!("Failed to load mpv_initialize: {}", e))?;
            let terminate_destroy_ptr = *lib
                .get::<unsafe fn(MpvHandle)>(b"mpv_terminate_destroy\0")
                .map_err(|e| format!("Failed to load mpv_terminate_destroy: {}", e))?;
            let command_ptr = *lib
                .get::<unsafe fn(MpvHandle, *const *const c_char) -> c_int>(b"mpv_command\0")
                .map_err(|e| format!("Failed to load mpv_command: {}", e))?;
            let command_string_ptr = *lib
                .get::<unsafe fn(MpvHandle, *const c_char) -> c_int>(b"mpv_command_string\0")
                .map_err(|e| format!("Failed to load mpv_command_string: {}", e))?;
            let set_option_string_ptr = *lib
                .get::<unsafe fn(MpvHandle, *const c_char, *const c_char) -> c_int>(
                    b"mpv_set_option_string\0",
                )
                .map_err(|e| format!("Failed to load mpv_set_option_string: {}", e))?;
            let get_property_string_ptr = *lib
                .get::<unsafe fn(MpvHandle, *const c_char) -> *mut c_char>(
                    b"mpv_get_property_string\0",
                )
                .map_err(|e| format!("Failed to load mpv_get_property_string: {}", e))?;
            let set_property_string_ptr = *lib
                .get::<unsafe fn(MpvHandle, *const c_char, *const c_char) -> c_int>(
                    b"mpv_set_property_string\0",
                )
                .map_err(|e| format!("Failed to load mpv_set_property_string: {}", e))?;
            let set_property_ptr = *lib
                .get::<unsafe fn(MpvHandle, *const c_char, c_int, *mut c_void) -> c_int>(
                    b"mpv_set_property\0",
                )
                .map_err(|e| format!("Failed to load mpv_set_property: {}", e))?;
            let get_property_ptr = *lib
                .get::<unsafe fn(MpvHandle, *const c_char, c_int, *mut c_void) -> c_int>(
                    b"mpv_get_property\0",
                )
                .map_err(|e| format!("Failed to load mpv_get_property: {}", e))?;
            let observe_property_ptr = *lib
                .get::<unsafe fn(MpvHandle, u64, *const c_char, c_int) -> c_int>(
                    b"mpv_observe_property\0",
                )
                .map_err(|e| format!("Failed to load mpv_observe_property: {}", e))?;
            let wait_event_ptr = *lib
                .get::<unsafe fn(MpvHandle, c_double) -> *mut MpvEvent>(b"mpv_wait_event\0")
                .map_err(|e| format!("Failed to load mpv_wait_event: {}", e))?;
            let free_ptr = *lib
                .get::<unsafe fn(*mut c_void)>(b"mpv_free\0")
                .map_err(|e| format!("Failed to load mpv_free: {}", e))?;

            Ok(Self {
                _lib: lib,
                create: create_ptr,
                initialize: initialize_ptr,
                terminate_destroy: terminate_destroy_ptr,
                command: command_ptr,
                command_string: command_string_ptr,
                set_option_string: set_option_string_ptr,
                get_property_string: get_property_string_ptr,
                set_property_string: set_property_string_ptr,
                set_property: set_property_ptr,
                get_property: get_property_ptr,
                observe_property: observe_property_ptr,
                wait_event: wait_event_ptr,
                free: free_ptr,
            })
        }
    }
}

// Helper to convert Rust string to C string
pub fn to_cstring(s: &str) -> CString {
    CString::new(s).unwrap_or_else(|_| CString::new("").unwrap())
}

// Helper to convert C string to Rust string
pub fn from_cstr(ptr: *const c_char) -> String {
    if ptr.is_null() {
        return String::new();
    }
    unsafe { CStr::from_ptr(ptr).to_string_lossy().into_owned() }
}
