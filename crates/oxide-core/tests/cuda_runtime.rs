use oxide_core::dictation::cuda::CudaRuntime;
use oxide_core::dictation::{CapabilityState, WhisperBackendRuntime};
use std::{path::PathBuf, sync::OnceLock};

#[path = "support/dictation_resources.rs"]
mod resources;

fn fixture_runtime(dir: &tempfile::TempDir, adapter: Option<String>) -> CudaRuntime {
    CudaRuntime::new(worker(dir), adapter).with_resources(resources::host_resources(6 << 30))
}

fn fixture(reply: serde_json::Value, logs: &str) -> tempfile::TempDir {
    static EXECUTABLE: OnceLock<(tempfile::TempDir, PathBuf)> = OnceLock::new();
    let (_, executable) = EXECUTABLE.get_or_init(|| {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("worker.rs");
        let exe = dir.path().join(format!("worker{}", std::env::consts::EXE_SUFFIX));
        std::fs::write(&source, r#"
use std::io::{Read, Write};
fn main() {
 let dir = std::env::current_exe().unwrap().parent().unwrap().to_owned();
 std::fs::write(dir.join("pid"), std::process::id().to_string()).unwrap();
 if let Ok(code) = std::fs::read_to_string(dir.join("exit-code")) { std::process::exit(code.parse().unwrap()); }
 let mut size = [0;4]; std::io::stdin().read_exact(&mut size).unwrap();
 let mut request = vec![0;u32::from_le_bytes(size) as usize];
 std::io::stdin().read_exact(&mut request).unwrap();
 if request != b"\"Probe\"" && dir.join("delay-ms").exists() {
   std::fs::write(dir.join("started"), b"ready").unwrap();
   std::thread::sleep(std::time::Duration::from_millis(1000));
 }
 let filename = if request == b"\"Probe\"" && dir.join("probe.json").exists() {"probe.json"} else {"reply.json"};
 let reply = std::fs::read(dir.join(filename)).unwrap();
 eprint!("{}", std::fs::read_to_string(dir.join("native.log")).unwrap());
 std::io::stdout().write_all(&(reply.len() as u32).to_le_bytes()).unwrap();
 std::io::stdout().write_all(&reply).unwrap();
}

"#).unwrap();
        assert!(std::process::Command::new("rustc").arg(&source).arg("-o").arg(&exe).status().unwrap().success());
        (dir, exe)
    });
    let dir = tempfile::tempdir().unwrap();
    std::fs::copy(executable, worker(&dir)).unwrap();
    std::fs::write(dir.path().join("reply.json"), reply.to_string()).unwrap();
    std::fs::write(dir.path().join("native.log"), logs).unwrap();
    dir
}

fn worker(dir: &tempfile::TempDir) -> PathBuf {
    dir.path()
        .join(format!("worker{}", std::env::consts::EXE_SUFFIX))
}

fn response(result: serde_json::Value) -> serde_json::Value {
    serde_json::json!({"protocol_version":1, "engine_version":"1.8.3", "result":result})
}

fn dispatch() -> serde_json::Value {
    serde_json::json!({
        "nativeBackend":"CUDA0",
        "adapter":"RTX 4090",
        "deviceId":null,
        "completedGraphs":12,
        "matrixOps":40,
        "failures":0
    })
}

fn transcription(extra: serde_json::Value) -> serde_json::Value {
    let mut value = serde_json::json!({"Ok":{"Transcription":{
        "text":"ask not what your country can do for you",
        "adapter_id":"cuda:0000000010de",
        "native_backend":"CUDA0"}}});
    if let Some(transcription) = value["Ok"]["Transcription"].as_object_mut() {
        for (key, entry) in extra.as_object().unwrap() {
            transcription.insert(key.clone(), entry.clone());
        }
    }
    response(value)
}

#[test]
fn an_omitted_worker_leaves_cpu_usable_and_does_not_advertise_cuda() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = CudaRuntime::new(dir.path().join("absent.exe"), None);
    assert_eq!(runtime.probe().state, CapabilityState::OmittedFromBuild);
    assert_eq!(
        oxide_core::dictation::CpuRuntime.probe().state,
        CapabilityState::Available
    );
}

#[test]
fn a_driver_error_is_reported_without_loading_it_into_the_host() {
    let dir = fixture(
        response(serde_json::json!({"Err":{"Unavailable":{"status":"missingDriverOrRuntime"}}})),
        "",
    );
    let runtime = fixture_runtime(&dir, None);
    assert_eq!(
        runtime.probe().state,
        CapabilityState::MissingDriverOrRuntime
    );
}

fn adapter() -> serde_json::Value {
    serde_json::json!({"id":"cuda:0000000010de", "name":"RTX 4090", "driver":"NVIDIA 565.90",
        "compute_capability":"8.9", "native_index":0, "native_backend":"CUDA0",
        "memory":{"unified":false,"totalBytes":6442450944u64,"availableBytes":5000000000u64},
        "capability":{"status":"available"}})
}

#[test]
fn a_probe_selects_the_requested_identity_without_claiming_verified_inference() {
    let dir = fixture(
        response(serde_json::json!({"Ok":{"Adapters":[adapter()]}})),
        "",
    );
    let runtime = fixture_runtime(&dir, Some("cuda:0000000010de".into()));
    let probe = runtime.probe();
    assert_eq!(probe.state, CapabilityState::Available);
    assert_eq!(probe.adapter.as_deref(), Some("RTX 4090"));
    assert_eq!(probe.memory_pool.unwrap().available_bytes, Some(5000000000));
    let devices = runtime.adapters().unwrap();
    assert_eq!(devices[0].id, "cuda:0000000010de");
    assert_eq!(devices[0].driver.as_deref(), Some("NVIDIA 565.90"));
    assert_eq!(devices[0].compute_capability, "8.9");
}

fn request() -> oxide_core::dictation::TranscriptionRequest {
    oxide_core::dictation::TranscriptionRequest {
        cancelled: Default::default(),
        model_path: "ggml-small.bin".into(),
        language: Some("en".into()),
        samples: vec![0.0; 1600],
        sample_rate: 16000,
        threads: 4,
    }
}

#[test]
fn unsupported_capabilities_and_initialization_errors_have_explicit_probe_states() {
    let unsupported = serde_json::json!({"id":"cuda:legacy", "name":"GeForce GT 710", "driver":null,
        "compute_capability":"3.5", "native_index":0, "native_backend":"CUDA0", "memory":null,
        "capability":{"status":"initializationFailure","details":"Requires compute capability >= 5.0"}});
    let dir = fixture(
        response(serde_json::json!({"Ok":{"Adapters":[unsupported]}})),
        "",
    );
    let runtime = fixture_runtime(&dir, None);
    assert_eq!(
        runtime.probe().state,
        CapabilityState::InitializationFailure("Requires compute capability >= 5.0".into())
    );
    assert!(matches!(
        runtime.transcribe(&request()),
        Err(oxide_core::dictation::BackendError::Unavailable(
            CapabilityState::InitializationFailure(_)
        ))
    ));
}

#[test]
fn model_selection_uses_the_catalogue_cuda_budget() {
    let dir = fixture(
        response(serde_json::json!({"Ok":{"Adapters":[adapter()]}})),
        "",
    );
    let runtime = fixture_runtime(&dir, None);
    let mut request = request();
    request.model_path = "ggml-large-v3.bin".into();
    assert!(matches!(
        runtime.transcribe(&request),
        Err(oxide_core::dictation::BackendError::InsufficientMemory {
            required_bytes: 13_421_772_800,
            ..
        })
    ));
}

#[test]
fn low_device_budget_refuses_gpu_inference_instead_of_silently_using_cpu() {
    let small_memory = serde_json::json!({"id":"cuda:0000000010de", "name":"RTX 4090", "driver":null,
        "compute_capability":"8.9", "native_index":0, "native_backend":"CUDA0",
        "memory":{"unified":false,"totalBytes":1000000000u64,"availableBytes":500000000u64},
        "capability":{"status":"available"}});
    let dir = fixture(
        response(serde_json::json!({"Ok":{"Adapters":[small_memory]}})),
        "",
    );
    let runtime = fixture_runtime(&dir, None);
    assert!(matches!(
        runtime.transcribe(&request()),
        Err(oxide_core::dictation::BackendError::InsufficientMemory { .. })
    ));
}

#[test]
fn native_allocation_failure_is_reported_as_memory_pressure() {
    let dir = fixture(
        response(serde_json::json!({"Err":{"InitializationFailed":"cudaMalloc failed"}})),
        "CUDA error: out of memory",
    );
    let runtime = fixture_runtime(&dir, None);
    assert!(matches!(
        runtime.transcribe(&request()),
        Err(oxide_core::dictation::BackendError::InsufficientMemory { .. })
    ));
}

#[test]
#[cfg(windows)]
fn windows_loader_failure_and_worker_crashes_are_recoverable() {
    let dir = fixture(serde_json::json!({}), "");
    std::fs::write(dir.path().join("exit-code"), "-1073741515").unwrap(); // 0xc0000135
    let runtime = fixture_runtime(&dir, None);
    assert_eq!(
        runtime.probe().state,
        CapabilityState::MissingDriverOrRuntime
    );

    std::fs::write(dir.path().join("exit-code"), "1").unwrap();
    assert!(matches!(
        runtime.probe().state,
        CapabilityState::InitializationFailure(_)
    ));
}

#[test]
fn adapter_disappearance_and_worker_initialization_failure_never_claim_gpu_success() {
    let dir = fixture(response(serde_json::json!({"Ok":{"Adapters":[]}})), "");
    let runtime = fixture_runtime(&dir, None);
    assert_eq!(runtime.probe().state, CapabilityState::NoCompatibleDevice);
    assert!(matches!(
        runtime.transcribe(&request()),
        Err(oxide_core::dictation::BackendError::Unavailable(
            CapabilityState::NoCompatibleDevice
        ))
    ));
}

#[test]
fn successful_text_without_native_gpu_execution_is_rejected() {
    let dir = fixture(
        response(serde_json::json!({"Ok":{"Transcription":{
            "text":"hello world","adapter_id":"cuda:0000000010de","native_backend":"CUDA0"}}})),
        "Running on CPU fallback silently",
    );
    std::fs::write(
        dir.path().join("probe.json"),
        response(serde_json::json!({"Ok":{"Adapters":[adapter()]}})).to_string(),
    )
    .unwrap();
    let runtime = fixture_runtime(&dir, None);
    assert!(matches!(
        runtime.transcribe(&request()),
        Err(oxide_core::dictation::BackendError::InferenceFailed(reason))
            if reason.contains("CUDA offload was not evidenced")
    ));
}

#[test]
fn inference_reports_the_actual_adapter_and_native_cuda_evidence() {
    let dir = fixture(
        transcription(serde_json::json!({"dispatch": dispatch()})),
        "whisper_backend_init_gpu: using CUDA0 backend\nggml_cuda_init: compute capability 8.9\nCUDA Timings: Total time: 1420.50 us.\n",
    );
    std::fs::write(
        dir.path().join("probe.json"),
        response(serde_json::json!({"Ok":{"Adapters":[adapter()]}})).to_string(),
    )
    .unwrap();
    let runtime = fixture_runtime(&dir, None);
    let outcome = runtime.transcribe(&request()).unwrap();
    assert_eq!(outcome.text, "ask not what your country can do for you");
    assert_eq!(
        outcome.execution.backend,
        oxide_core::dictation::BackendId::Cuda
    );
    assert_eq!(outcome.execution.adapter.as_deref(), Some("RTX 4090"));
    assert!(outcome.execution.offloaded);
    let evidence = outcome.execution.offload_evidence.unwrap();
    assert!(evidence.contains("whisper.cpp 1.8.3"));
    assert!(evidence.contains("cuda:0000000010de"));
    assert!(evidence.contains("using CUDA0 backend"));
    assert!(evidence.contains("12 graphs"));
}

#[test]
fn missing_native_dispatch_evidence_is_rejected() {
    let dir = fixture(
        transcription(serde_json::json!({})),
        "whisper_backend_init_gpu: using CUDA0 backend\nggml_cuda_init: compute capability 8.9\n",
    );
    std::fs::write(
        dir.path().join("probe.json"),
        response(serde_json::json!({"Ok":{"Adapters":[adapter()]}})).to_string(),
    )
    .unwrap();
    let runtime = fixture_runtime(&dir, None);
    assert!(matches!(
        runtime.transcribe(&request()),
        Err(oxide_core::dictation::BackendError::InferenceFailed(reason))
            if reason.contains("CUDA offload was not evidenced")
    ));
}

#[test]
fn invalid_native_dispatch_evidence_is_rejected() {
    for invalid in [
        serde_json::json!({"completedGraphs":0}),
        serde_json::json!({"matrixOps":1}),
        serde_json::json!({"failures":1}),
        serde_json::json!({"nativeBackend":"CUDA1"}),
        serde_json::json!({"adapter":"Some Other GPU"}),
    ] {
        let mut run = dispatch();
        for (key, value) in invalid.as_object().unwrap() {
            run[key] = value.clone();
        }
        let dir = fixture(
            transcription(serde_json::json!({"dispatch": run})),
            "whisper_backend_init_gpu: using CUDA0 backend\n",
        );
        std::fs::write(
            dir.path().join("probe.json"),
            response(serde_json::json!({"Ok":{"Adapters":[adapter()]}})).to_string(),
        )
        .unwrap();
        let runtime = fixture_runtime(&dir, None);
        assert!(
            matches!(
                runtime.transcribe(&request()),
                Err(oxide_core::dictation::BackendError::InferenceFailed(reason))
                    if reason.contains("CUDA offload was not evidenced")
            ),
            "expected {invalid} to be rejected"
        );
    }
}

#[test]
fn cancellation_terminates_the_worker_and_allows_a_new_inference() {
    let dir = fixture(
        response(serde_json::json!({"Ok":{"Transcription":{
            "text":"ignored","adapter_id":"cuda:0000000010de","native_backend":"CUDA0"}}})),
        "whisper_backend_init_gpu: using CUDA0 backend\nCUDA Timings: Total time: 1200 us.\n",
    );
    std::fs::write(dir.path().join("delay-ms"), "1000").unwrap();
    std::fs::write(
        dir.path().join("probe.json"),
        response(serde_json::json!({"Ok":{"Adapters":[adapter()]}})).to_string(),
    )
    .unwrap();
    let runtime = std::sync::Arc::new(fixture_runtime(&dir, None));
    let worker_clone = runtime.clone();
    let handle = std::thread::spawn(move || worker_clone.transcribe(&request()));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !dir.path().join("started").exists() {
        assert!(
            !handle.is_finished(),
            "CUDA inference ended before the worker started"
        );
        assert!(
            std::time::Instant::now() < deadline,
            "CUDA worker did not start"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    runtime.cancel();
    assert!(matches!(
        handle.join().unwrap(),
        Err(oxide_core::dictation::BackendError::Cancelled)
    ));
}

#[test]
fn host_ram_pressure_refuses_the_model_before_starting_inference() {
    let dir = fixture(
        response(serde_json::json!({"Ok":{"Transcription":{
        "text":"unused","adapter_id":"cuda:0000000010de","native_backend":"CUDA0"}}})),
        "",
    );
    std::fs::write(
        dir.path().join("probe.json"),
        response(serde_json::json!({"Ok":{"Adapters":[adapter()]}})).to_string(),
    )
    .unwrap();
    std::fs::write(dir.path().join("delay-ms"), "1000").unwrap();
    let runtime = fixture_runtime(&dir, None).with_resources(resources::host_resources(3 << 30));
    assert!(matches!(
        runtime.transcribe(&request()),
        Err(oxide_core::dictation::BackendError::InsufficientMemory {
            required_bytes: 3_865_470_567,
            ..
        })
    ));
    assert!(!dir.path().join("started").exists());
}

#[test]
fn cancelled_recording_never_starts_a_cuda_worker() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("started");
    let runtime = CudaRuntime::new(dir.path().join("uncalled.exe"), None);
    let req = request();
    req.cancelled
        .store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(matches!(
        runtime.transcribe(&req),
        Err(oxide_core::dictation::BackendError::Cancelled)
    ));
    assert!(!marker.exists());
}

#[test]
#[cfg(windows)]
fn cuda_and_vulkan_coexist_without_mandatory_cuda_loading_at_startup() {
    let dir = tempfile::tempdir().unwrap();
    let cuda_bin = dir
        .path()
        .join(format!("oxide-cuda-worker{}", std::env::consts::EXE_SUFFIX));
    let vulkan_bin = dir.path().join(format!(
        "oxide-vulkan-worker{}",
        std::env::consts::EXE_SUFFIX
    ));
    std::fs::write(
        &cuda_bin,
        b"invalid-executable-that-would-crash-if-executed",
    )
    .unwrap();
    std::fs::write(
        &vulkan_bin,
        b"invalid-executable-that-would-crash-if-executed",
    )
    .unwrap();

    // With both workers present, default_runtime must not crash or spawn workers eagerly
    unsafe {
        std::env::set_var("OXIDE_CUDA_WORKER", &cuda_bin);
        std::env::set_var("OXIDE_VULKAN_WORKER", &vulkan_bin);
        std::env::remove_var("OXIDE_DICTATION_BACKEND");
    }
    let runtime = oxide_core::dictation::default_runtime();
    // Preserves Vulkan as the default when both exist without assuming CUDA is faster
    assert_eq!(
        runtime.backend_id(),
        oxide_core::dictation::BackendId::Vulkan
    );

    // Explicit override selects CUDA without assuming precedence
    unsafe {
        std::env::set_var("OXIDE_DICTATION_BACKEND", "cuda");
    }
    let cuda_runtime = oxide_core::dictation::default_runtime();
    assert_eq!(
        cuda_runtime.backend_id(),
        oxide_core::dictation::BackendId::Cuda
    );

    unsafe {
        std::env::remove_var("OXIDE_CUDA_WORKER");
        std::env::remove_var("OXIDE_VULKAN_WORKER");
        std::env::remove_var("OXIDE_DICTATION_BACKEND");
    }
}
#[test]
fn recording_token_cancels_an_independently_selected_worker() {
    let dir = fixture(
        response(serde_json::json!({"Ok":{"Transcription":{
            "text":"ignored","adapter_id":"cuda:0000000010de","native_backend":"CUDA0"}}})),
        "whisper_backend_init_gpu: using CUDA0 backend\nCUDA Timings: Total time: 1200 us.\n",
    );
    std::fs::write(dir.path().join("delay-ms"), "1000").unwrap();
    std::fs::write(
        dir.path().join("probe.json"),
        response(serde_json::json!({"Ok":{"Adapters":[adapter()]}})).to_string(),
    )
    .unwrap();
    let runtime = std::sync::Arc::new(fixture_runtime(&dir, None));
    let worker_clone = runtime.clone();
    let req = request();
    let cancelled = req.cancelled.clone();
    let handle = std::thread::spawn(move || worker_clone.transcribe(&req));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !dir.path().join("started").exists() {
        assert!(
            !handle.is_finished(),
            "CUDA inference ended before the worker started"
        );
        assert!(
            std::time::Instant::now() < deadline,
            "CUDA worker did not start"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    cancelled.store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(matches!(
        handle.join().unwrap(),
        Err(oxide_core::dictation::BackendError::Cancelled)
    ));
}

#[test]
fn incompatible_protocol_version_is_rejected_without_panicking() {
    let dir = fixture(
        serde_json::json!({"protocol_version":2, "engine_version":"1.8.3",
            "result":{"Ok":{"Adapters":[adapter()]}}}),
        "",
    );
    let runtime = fixture_runtime(&dir, None);
    assert!(matches!(
        runtime.probe().state,
        CapabilityState::InitializationFailure(message) if message.contains("Incompatible")
    ));
}

#[test]
fn incompatible_engine_version_is_rejected_without_panicking() {
    let dir = fixture(
        serde_json::json!({"protocol_version":1, "engine_version":"9.9.9",
            "result":{"Ok":{"Adapters":[adapter()]}}}),
        "",
    );
    let runtime = fixture_runtime(&dir, None);
    assert!(matches!(
        runtime.probe().state,
        CapabilityState::InitializationFailure(message) if message.contains("Incompatible")
    ));
}

#[test]
fn a_worker_that_exits_before_replying_is_a_typed_failure() {
    let dir = fixture(
        response(serde_json::json!({"Ok":{"Adapters":[adapter()]}})),
        "",
    );
    std::fs::write(dir.path().join("exit-code"), "3").unwrap();
    let runtime = fixture_runtime(&dir, None);
    assert!(matches!(
        runtime.probe().state,
        CapabilityState::InitializationFailure(_)
    ));
}

#[cfg(unix)]
#[test]
fn cancellation_reaps_the_worker_instead_of_leaving_a_zombie() {
    let dir = fixture(
        response(serde_json::json!({"Ok":{"Transcription":{
            "text":"ignored","adapter_id":"cuda:0000000010de","native_backend":"CUDA0"}}})),
        "whisper_backend_init_gpu: using CUDA0 backend\nCUDA Timings: Total time: 1200 us.\n",
    );
    std::fs::write(dir.path().join("delay-ms"), "1000").unwrap();
    std::fs::write(
        dir.path().join("probe.json"),
        response(serde_json::json!({"Ok":{"Adapters":[adapter()]}})).to_string(),
    )
    .unwrap();
    let runtime = std::sync::Arc::new(fixture_runtime(&dir, None));
    let worker_clone = runtime.clone();
    let handle = std::thread::spawn(move || worker_clone.transcribe(&request()));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !dir.path().join("started").exists() || !dir.path().join("pid").exists() {
        assert!(
            !handle.is_finished(),
            "CUDA inference ended before the worker started"
        );
        assert!(
            std::time::Instant::now() < deadline,
            "CUDA worker did not start"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let pid: i32 = std::fs::read_to_string(dir.path().join("pid"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    runtime.cancel();
    assert!(matches!(
        handle.join().unwrap(),
        Err(oxide_core::dictation::BackendError::Cancelled)
    ));

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        // A zombie still answers signal 0, so ESRCH proves the child was reaped.
        if unsafe { libc::kill(pid, 0) } != 0 {
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ESRCH)
            );
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "CUDA worker {pid} was not reaped"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}
