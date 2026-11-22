//! Native system integration on Windows: ShellExecute and Explorer.

use crate::diag;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use windows_sys::Win32::UI::Shell::ShellExecuteW;

/// Opens `url` in the default browser. Core passes only links it has checked.
pub fn open_url(url: &str) {
    let wide_url: Vec<u16> = std::ffi::OsStr::new(url)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let wide_op: Vec<u16> = std::ffi::OsStr::new("open")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: ShellExecuteW is called with valid null-terminated UTF-16 strings.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            wide_op.as_ptr(),
            wide_url.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1, // SW_SHOWNORMAL
        )
    };
    if (result as usize) <= 32 {
        diag::best_effort(
            "rundll32",
            crate::command::os_command("rundll32")
                .args(["url.dll,FileProtocolHandler", url])
                .spawn(),
        );
    }
}

/// Shows `path` selected in Explorer.
pub fn reveal_in_file_manager(path: &Path) {
    use std::os::windows::process::CommandExt;
    // `raw_arg`: the quoted path is one argument, so a comma in a folder name cannot split it.
    diag::best_effort(
        "explorer",
        crate::command::os_command("explorer")
            .raw_arg(crate::explorer::select_arg(&path.to_string_lossy()))
            .spawn(),
    );
}

/// Windows shows no Dock icon.
pub fn set_dev_dock_icon(_png: &[u8]) {}

/// Returns a sorted, deduplicated list of installed font family names via GDI.
pub fn system_fonts() -> Vec<String> {
    use windows_sys::Win32::Foundation::LPARAM;
    use windows_sys::Win32::Graphics::Gdi::{
        DEFAULT_CHARSET, EnumFontFamiliesExW, GetDC, LOGFONTW, ReleaseDC, TEXTMETRICW,
    };

    unsafe extern "system" fn collect_font(
        lpelfe: *const LOGFONTW,
        _lpntme: *const TEXTMETRICW,
        _font_type: u32,
        lparam: LPARAM,
    ) -> i32 {
        if lpelfe.is_null() || lparam == 0 {
            return 1;
        }
        // SAFETY: `EnumFontFamiliesExW` passes a valid `LOGFONTW` pointer and our `Vec<String>`
        // pointer as `lparam` for the duration of the synchronous call.
        let families = unsafe { &mut *(lparam as *mut Vec<String>) };
        // SAFETY: `lpelfe` was checked non-null above and points to a valid `LOGFONTW`.
        let face = unsafe { &(*lpelfe).lfFaceName };
        let len = face.iter().position(|&c| c == 0).unwrap_or(face.len());
        families.push(String::from_utf16_lossy(&face[..len]));
        1
    }

    // SAFETY: `GetDC(null)` returns the screen device context (or null on failure).
    let hdc = unsafe { GetDC(std::ptr::null_mut()) };
    if hdc.is_null() {
        return Vec::new();
    }
    // SAFETY: `LOGFONTW` is a plain C struct where zero-initialization is valid.
    let mut logfont: LOGFONTW = unsafe { std::mem::zeroed() };
    logfont.lfCharSet = DEFAULT_CHARSET as u8;
    let mut raw_families: Vec<String> = Vec::new();
    // SAFETY: `hdc` is a valid screen DC, `logfont` is initialized, and `raw_families` outlives
    // the synchronous `EnumFontFamiliesExW` call.
    unsafe {
        EnumFontFamiliesExW(
            hdc,
            &logfont,
            Some(collect_font),
            (&raw mut raw_families) as LPARAM,
            0,
        );
        ReleaseDC(std::ptr::null_mut(), hdc);
    }
    crate::fonts::normalize_font_families(raw_families)
}
