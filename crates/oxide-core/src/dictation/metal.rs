//! macOS Apple Silicon Metal backend integration.
//!
//! Queries physical Metal device properties via Objective-C runtime and executes
//! accelerated inference through pinned whisper.cpp Metal kernels.

use super::runtime::{
    BackendError, TranscriptionOutcome, TranscriptionRequest, WhisperBackendRuntime,
};
use super::types::{BackendId, BackendProbe, CapabilityState, ExecutionDetails, MemoryPool};
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use std::ffi::CStr;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use std::os::raw::{c_char, c_void};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetalDeviceInfo {
    pub name: String,
    pub unified_memory: bool,
    pub max_working_set_bytes: Option<u64>,
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub fn query_metal_device() -> Result<MetalDeviceInfo, String> {
    unsafe {
        unsafe extern "C" {
            fn MTLCreateSystemDefaultDevice() -> *mut c_void;
            fn sel_registerName(name: *const c_char) -> *mut c_void;
            fn objc_msgSend();
        }

        let device = MTLCreateSystemDefaultDevice();
        if device.is_null() {
            return Err("No Metal-compatible default device found".into());
        }

        type MsgSendPtr = unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void;
        type MsgSendBool = unsafe extern "C" fn(*mut c_void, *mut c_void) -> u8;
        type MsgSendU64 = unsafe extern "C" fn(*mut c_void, *mut c_void) -> u64;
        type MsgSendStr = unsafe extern "C" fn(*mut c_void, *mut c_void) -> *const c_char;
        type MsgSendVoid = unsafe extern "C" fn(*mut c_void, *mut c_void);

        let msg_send_ptr: MsgSendPtr = std::mem::transmute(objc_msgSend as *const ());
        let msg_send_bool: MsgSendBool = std::mem::transmute(objc_msgSend as *const ());
        let msg_send_u64: MsgSendU64 = std::mem::transmute(objc_msgSend as *const ());
        let msg_send_str: MsgSendStr = std::mem::transmute(objc_msgSend as *const ());
        let msg_send_void: MsgSendVoid = std::mem::transmute(objc_msgSend as *const ());

        // 1. Query name: [device name] -> NSString -> UTF8String
        let name_sel = sel_registerName(c"name".as_ptr());
        let ns_name = msg_send_ptr(device, name_sel);
        let name = if !ns_name.is_null() {
            let utf8_sel = sel_registerName(c"UTF8String".as_ptr());
            let cstr = msg_send_str(ns_name, utf8_sel);
            if !cstr.is_null() {
                CStr::from_ptr(cstr).to_string_lossy().to_string()
            } else {
                "Apple Silicon Metal".to_string()
            }
        } else {
            "Apple Silicon Metal".to_string()
        };

        // 2. Query hasUnifiedMemory: [device hasUnifiedMemory] -> BOOL
        let has_unified_sel = sel_registerName(c"hasUnifiedMemory".as_ptr());
        let unified_memory = msg_send_bool(device, has_unified_sel) != 0;

        // 3. Query recommendedMaxWorkingSetSize: [device recommendedMaxWorkingSetSize] -> uint64_t
        let max_working_set_sel = sel_registerName(c"recommendedMaxWorkingSetSize".as_ptr());
        let max_working_set_bytes = {
            let val = msg_send_u64(device, max_working_set_sel);
            if val > 0 { Some(val) } else { None }
        };

        // Release the retained device object
        let release_sel = sel_registerName(c"release".as_ptr());
        msg_send_void(device, release_sel);

        if !unified_memory {
            return Err(format!(
                "Device '{name}' does not have unified memory; Intel Mac GPU support remains unadvertised"
            ));
        }

        Ok(MetalDeviceInfo {
            name,
            unified_memory,
            max_working_set_bytes,
        })
    }
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
pub fn query_metal_device() -> Result<MetalDeviceInfo, String> {
    Err("Metal acceleration is only supported on Apple Silicon macOS".into())
}

/// Pure acceptance check for one normal-inference dispatch run.
///
/// Metal offload is only proven by a completed matrix-bearing graph on the same
/// native backend and device the request selected. A successful transcription
/// or a requested GPU mode by itself never satisfies this.
pub fn validate_metal_dispatch(
    run: &super::benchmark::DispatchRun,
    adapter: &str,
) -> Result<(), BackendError> {
    if run.proves(super::BackendId::Metal, "Metal", adapter) {
        return Ok(());
    }
    Err(BackendError::InferenceFailed(format!(
        "Metal offload was not proven: expected a completed matrix-bearing Metal dispatch on '{adapter}', observed backend '{}', adapter '{}', {} completed graph(s), {} matrix op(s), {} failure(s). Try CPU.",
        run.native_backend, run.adapter, run.completed_graphs, run.matrix_ops, run.failures
    )))
}

fn contextualize(error: BackendError) -> BackendError {
    match error {
        BackendError::InitializationFailed(msg) => {
            BackendError::InitializationFailed(format!("Metal initialization failed: {msg}"))
        }
        BackendError::InferenceFailed(msg) => {
            BackendError::InferenceFailed(format!("Metal inference failed: {msg}"))
        }
        other => other,
    }
}

/// Native Metal execution runtime for macOS Apple Silicon.
#[derive(Default)]
pub struct MetalRuntime;

impl WhisperBackendRuntime for MetalRuntime {
    fn backend_id(&self) -> BackendId {
        BackendId::Metal
    }

    fn probe(&self) -> BackendProbe {
        let manifest = super::types::BuildManifest::current();
        if !manifest.included_backends.contains(&BackendId::Metal) {
            return BackendProbe {
                backend: BackendId::Metal,
                state: CapabilityState::OmittedFromBuild,
                adapter: None,
                memory_pool: None,
            };
        }

        match query_metal_device() {
            Ok(device) => {
                let (total_bytes, available_bytes) = if let Ok(mut system) = sysinfo::System::new()
                {
                    system.refresh_memory();
                    (system.total_memory(), Some(system.available_memory()))
                } else {
                    (0, None)
                };

                BackendProbe {
                    backend: BackendId::Metal,
                    state: CapabilityState::Available,
                    adapter: Some(device.name),
                    memory_pool: Some(MemoryPool {
                        unified: device.unified_memory,
                        total_bytes,
                        available_bytes,
                        max_working_set_bytes: device.max_working_set_bytes,
                    }),
                }
            }
            Err(_e) => BackendProbe {
                backend: BackendId::Metal,
                state: CapabilityState::NoCompatibleDevice,
                adapter: None,
                memory_pool: None,
            },
        }
    }

    fn transcribe(
        &self,
        request: &TranscriptionRequest,
    ) -> Result<TranscriptionOutcome, BackendError> {
        let device_info = query_metal_device()
            .map_err(|_| BackendError::Unavailable(CapabilityState::NoCompatibleDevice))?;

        if !request.model_path.is_file() {
            return Err(BackendError::InitializationFailed(format!(
                "Model file not found at: {}",
                request.model_path.display()
            )));
        }

        // Keep the memory preflight before any device context exists.
        super::resources::check_before_load(&request.model_path, &self.probe())
            .map_err(contextualize)?;

        // The native hook is installed once per process before the first context
        // so whisper.cpp's Metal backend is instrumented from initialization on.
        let recorder = super::benchmark::MetalDispatchRecorder::install(&device_info.name)
            .map_err(contextualize)?;

        let (text, dispatch) =
            super::runtime::run_whisper_recorded(request, &recorder).map_err(contextualize)?;

        // Never report offload from the request flag: only observed native
        // dispatches on the selected Metal device count.
        validate_metal_dispatch(&dispatch, &device_info.name)?;

        let budget_desc = match device_info.max_working_set_bytes {
            Some(bytes) => format!(", max working set {:.1} GB", bytes as f64 / 1_073_741_824.0),
            None => String::new(),
        };

        Ok(TranscriptionOutcome {
            text,
            execution: ExecutionDetails {
                fallback_reason: None,
                backend: BackendId::Metal,
                adapter: Some(device_info.name.clone()),
                offloaded: true,
                offload_evidence: Some(format!(
                    "Metal dispatch verified on {}: {} completed matrix-bearing graph(s), {} matrix op(s), 0 failures (unified memory{})",
                    device_info.name, dispatch.completed_graphs, dispatch.matrix_ops, budget_desc
                )),
            },
        })
    }
}
