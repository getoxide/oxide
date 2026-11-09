use oxide_core::dictation::protocol::{
    MAX_FRAME, PROBE_TIMEOUT, TRANSCRIPTION_TIMEOUT, read_frame, timeout_for, write_frame,
};
use serde_json::{Value, json};
use std::time::Duration;

#[test]
fn a_frame_round_trips_through_the_length_prefixed_encoding() {
    let value = json!({"Probe": null, "note": "round trip"});
    let mut encoded = Vec::new();
    write_frame(&mut encoded, &value).unwrap();

    let decoded = read_frame::<Value>(encoded.as_slice()).unwrap();
    assert_eq!(decoded, value);
}

#[test]
fn a_declared_length_above_the_limit_is_rejected_before_reading_the_body() {
    let mut encoded = ((MAX_FRAME + 1) as u32).to_le_bytes().to_vec();
    encoded.extend_from_slice(b"{}");

    let error = read_frame::<Value>(encoded.as_slice()).unwrap_err();
    assert!(error.to_string().contains("exceeds limit"));
}

#[test]
fn a_truncated_body_is_rejected() {
    let mut encoded = 100u32.to_le_bytes().to_vec();
    encoded.extend_from_slice(b"{}");

    assert!(read_frame::<Value>(encoded.as_slice()).is_err());
}

#[test]
fn invalid_json_is_rejected() {
    let body = b"not json";
    let mut encoded = (body.len() as u32).to_le_bytes().to_vec();
    encoded.extend_from_slice(body);

    assert!(read_frame::<Value>(encoded.as_slice()).is_err());
}

#[test]
fn a_closed_or_empty_input_is_rejected_instead_of_panicking() {
    assert!(read_frame::<Value>(std::io::empty()).is_err());
    assert!(read_frame::<Value>(&[][..]).is_err());
}

#[test]
fn probes_use_the_short_timeout_and_transcription_the_long_one() {
    assert_eq!(PROBE_TIMEOUT, Duration::from_secs(15));
    assert_eq!(TRANSCRIPTION_TIMEOUT, Duration::from_secs(180));
    assert_eq!(timeout_for(true), PROBE_TIMEOUT);
    assert_eq!(timeout_for(false), TRANSCRIPTION_TIMEOUT);
}
