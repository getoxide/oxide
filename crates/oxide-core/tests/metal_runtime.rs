//! Metal evidence validation and build-gating contracts that need no GPU.

use oxide_core::dictation::BackendError;
use oxide_core::dictation::benchmark::DispatchRun;
use oxide_core::dictation::metal::validate_metal_dispatch;

fn dispatch(
    completed_graphs: u64,
    matrix_ops: u64,
    failures: u64,
    native_backend: &str,
    adapter: &str,
) -> DispatchRun {
    DispatchRun {
        native_backend: native_backend.into(),
        adapter: adapter.into(),
        device_id: None,
        completed_graphs,
        matrix_ops,
        failures,
    }
}

#[test]
fn accepts_a_completed_matrix_bearing_metal_dispatch() {
    let run = dispatch(12, 40, 0, "Metal", "Apple M1 Pro");
    validate_metal_dispatch(&run, "Apple M1 Pro").unwrap();
}

#[test]
fn rejects_a_dispatch_without_completed_graphs() {
    let run = dispatch(0, 0, 0, "Metal", "Apple M1 Pro");
    let error = validate_metal_dispatch(&run, "Apple M1 Pro").unwrap_err();
    assert!(matches!(error, BackendError::InferenceFailed(_)));
    assert!(
        error.to_string().contains("Metal offload was not proven"),
        "rejection must explain that offload was not proven: {error}"
    );
}

#[test]
fn rejects_a_matrix_bearing_claim_with_fewer_matrix_ops_than_graphs() {
    let run = dispatch(12, 11, 0, "Metal", "Apple M1 Pro");
    let error = validate_metal_dispatch(&run, "Apple M1 Pro").unwrap_err();
    assert!(matches!(error, BackendError::InferenceFailed(_)));
}

#[test]
fn rejects_a_dispatch_with_failed_graphs() {
    let run = dispatch(12, 40, 1, "Metal", "Apple M1 Pro");
    let error = validate_metal_dispatch(&run, "Apple M1 Pro").unwrap_err();
    assert!(matches!(error, BackendError::InferenceFailed(_)));
}

#[test]
fn rejects_a_dispatch_from_another_native_backend() {
    let run = dispatch(12, 40, 0, "CUDA0", "Apple M1 Pro");
    let error = validate_metal_dispatch(&run, "Apple M1 Pro").unwrap_err();
    assert!(matches!(error, BackendError::InferenceFailed(_)));
}

#[test]
fn rejects_a_dispatch_from_another_adapter() {
    let run = dispatch(12, 40, 0, "Metal", "Apple M2");
    let error = validate_metal_dispatch(&run, "Apple M1 Pro").unwrap_err();
    assert!(matches!(error, BackendError::InferenceFailed(_)));
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
#[test]
fn metal_probe_is_omitted_from_non_apple_silicon_builds() {
    use oxide_core::dictation::{BackendId, CapabilityState, MetalRuntime, WhisperBackendRuntime};
    let probe = MetalRuntime.probe();
    assert_eq!(probe.backend, BackendId::Metal);
    assert_eq!(probe.state, CapabilityState::OmittedFromBuild);
    assert!(probe.adapter.is_none());
    assert!(probe.memory_pool.is_none());
}
