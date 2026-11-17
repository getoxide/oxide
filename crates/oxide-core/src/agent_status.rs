//! Status and Turns of a terminal Thread, from OSC 7501 (the Program Status Protocol) that the
//! Provider CLI prints into its terminal (ADR-0017).
//!
//! Everything here is pure: the parser of the child's untrusted output, the mapping from a
//! report to a Thread status, the Turn boundaries and the rate limit. Nothing is inferred from
//! screen text, and no Provider configuration is touched.

use crate::ThreadStatus;
use std::time::{Duration, Instant};

/// The longest OSC body the parser keeps. The child's output is untrusted: a longer sequence is
/// skipped instead of buffered.
const MAX_BODY: usize = 4096;

/// What the Provider says its state is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReportedState {
    Idle,
    Working,
    Blocked,
    Done,
    Error,
    /// The record is withdrawn: the Provider says nothing about its state any more.
    Clear,
}

/// One thing the child said through OSC 7501.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Osc7501Event {
    Report(ReportedState),
    /// The feature query: the Provider only reports after a positive answer.
    Query,
}

/// The answer to the feature query: the states and kinds Oxide understands.
pub(crate) const QUERY_REPLY: &[u8] =
    b"\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\";

/// The Thread status a report stands for. `done` and `idle` both mean the Turn is over.
pub(crate) fn thread_status(state: ReportedState) -> ThreadStatus {
    match state {
        ReportedState::Working => ThreadStatus::Working,
        ReportedState::Blocked => ThreadStatus::NeedsInput,
        ReportedState::Done | ReportedState::Idle => ThreadStatus::Completed,
        ReportedState::Error => ThreadStatus::Error,
        ReportedState::Clear => ThreadStatus::Running,
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Ground,
    Esc,
    Osc,
    OscEsc,
    Skip,
    SkipEsc,
}

/// Finds OSC 7501 sequences in a byte stream that arrives in arbitrary chunks. Every other
/// byte, and every other OSC, is ignored.
pub(crate) struct Osc7501Parser {
    mode: Mode,
    body: Vec<u8>,
}

impl Osc7501Parser {
    pub(crate) fn new() -> Self {
        Self {
            mode: Mode::Ground,
            body: Vec::new(),
        }
    }

    pub(crate) fn feed(&mut self, chunk: &[u8]) -> Vec<Osc7501Event> {
        let mut events = Vec::new();
        for &byte in chunk {
            self.mode = match (self.mode, byte) {
                (Mode::Ground, 0x1b) => Mode::Esc,
                (Mode::Ground, _) => Mode::Ground,
                (Mode::Esc | Mode::OscEsc | Mode::SkipEsc, b']') => {
                    self.body.clear();
                    Mode::Osc
                }
                (Mode::Esc, 0x1b) => Mode::Esc,
                (Mode::Esc, _) => Mode::Ground,
                (Mode::Osc, 0x07) | (Mode::OscEsc, b'\\') => {
                    events.extend(parse_body(&self.body));
                    self.body.clear();
                    Mode::Ground
                }
                // CAN and SUB abort a sequence.
                (Mode::Osc, 0x18 | 0x1a) => {
                    self.body.clear();
                    Mode::Ground
                }
                (Mode::Osc, 0x1b) => Mode::OscEsc,
                (Mode::Osc, _) => {
                    self.body.push(byte);
                    if self.body.len() > MAX_BODY {
                        self.body.clear();
                        Mode::Skip
                    } else {
                        Mode::Osc
                    }
                }
                (Mode::OscEsc, 0x1b) => Mode::OscEsc,
                (Mode::OscEsc, _) => {
                    self.body.clear();
                    Mode::Ground
                }
                (Mode::Skip, 0x07) | (Mode::SkipEsc, b'\\') => Mode::Ground,
                (Mode::Skip | Mode::SkipEsc, 0x1b) => Mode::SkipEsc,
                (Mode::Skip | Mode::SkipEsc, _) => Mode::Skip,
            };
        }
        events
    }
}

/// `7501;?` is the query; `7501;state=<state>[:key=value]*` is a report. Anything else is
/// ignored, a malformed record included.
fn parse_body(body: &[u8]) -> Option<Osc7501Event> {
    let text = std::str::from_utf8(body).ok()?;
    let rest = text.strip_prefix("7501;")?;
    if rest == "?" {
        return Some(Osc7501Event::Query);
    }
    let state = rest
        .split(':')
        .find_map(|field| field.strip_prefix("state="))?;
    let state = match state {
        "idle" => ReportedState::Idle,
        "working" => ReportedState::Working,
        "blocked" => ReportedState::Blocked,
        "done" => ReportedState::Done,
        "error" => ReportedState::Error,
        "clear" => ReportedState::Clear,
        _ => return None,
    };
    Some(Osc7501Event::Report(state))
}

/// How a Turn ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TurnEnd {
    Completed,
    Error,
}

/// What a report does to the Thread's Turns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TurnChange {
    Started,
    Ended(TurnEnd),
}

/// A Turn runs from a `working` report until the next `done`, `idle` or `error`. `blocked` (an
/// Approval) happens inside a Turn and does not end it.
#[derive(Default)]
pub(crate) struct TurnTracker {
    open: bool,
}

impl TurnTracker {
    pub(crate) fn apply(&mut self, state: ReportedState) -> Option<TurnChange> {
        match state {
            ReportedState::Working if !self.open => {
                self.open = true;
                Some(TurnChange::Started)
            }
            ReportedState::Done | ReportedState::Idle if self.open => {
                self.open = false;
                Some(TurnChange::Ended(TurnEnd::Completed))
            }
            ReportedState::Error if self.open => {
                self.open = false;
                Some(TurnChange::Ended(TurnEnd::Error))
            }
            _ => None,
        }
    }
}

/// Keeps the sidebar from flickering: a status change is published at once unless one was
/// published less than `interval` ago, in which case only the latest is kept and published when
/// the interval is over. Intermediate changes are dropped; the last one always arrives.
pub(crate) struct StatusGate {
    interval: Duration,
    published: Option<ThreadStatus>,
    last_published: Option<Instant>,
    pending: Option<ThreadStatus>,
}

impl StatusGate {
    pub(crate) fn new(interval: Duration) -> Self {
        Self {
            interval,
            published: None,
            last_published: None,
            pending: None,
        }
    }

    /// The status to publish now, if any.
    pub(crate) fn offer(&mut self, now: Instant, status: ThreadStatus) -> Option<ThreadStatus> {
        self.pending = Some(status);
        self.flush(now)
    }

    /// The pending status, once it is allowed out.
    pub(crate) fn flush(&mut self, now: Instant) -> Option<ThreadStatus> {
        let status = self.pending?;
        if self.published == Some(status) {
            self.pending = None;
            return None;
        }
        if self
            .last_published
            .is_some_and(|at| now.saturating_duration_since(at) < self.interval)
        {
            return None;
        }
        self.pending = None;
        self.published = Some(status);
        self.last_published = Some(now);
        Some(status)
    }

    /// When the pending status may go out; `None` when nothing waits.
    pub(crate) fn due(&self) -> Option<Instant> {
        self.pending?;
        Some(self.last_published? + self.interval)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn events(chunks: &[&[u8]]) -> Vec<Osc7501Event> {
        let mut parser = Osc7501Parser::new();
        chunks.iter().flat_map(|c| parser.feed(c)).collect()
    }

    fn report(state: ReportedState) -> Osc7501Event {
        Osc7501Event::Report(state)
    }

    #[test]
    fn a_report_ended_by_st_or_bel_is_read_between_ordinary_output() {
        let got = events(&[
            b"hello\x1b[31m red \x1b]7501;state=working:app=claude\x1b\\more\x1b]7501;state=done\x07",
        ]);
        assert_eq!(
            got,
            [report(ReportedState::Working), report(ReportedState::Done)]
        );
    }

    #[test]
    fn a_report_split_across_chunks_at_every_byte_is_still_read() {
        let stream = b"x\x1b]7501;state=blocked:kind=permission:app=codex\x1b\\y";
        for at in 1..stream.len() {
            let got = events(&[&stream[..at], &stream[at..]]);
            assert_eq!(got, [report(ReportedState::Blocked)], "split at {at}");
        }
        let one_by_one: Vec<&[u8]> = stream.chunks(1).collect();
        assert_eq!(events(&one_by_one), [report(ReportedState::Blocked)]);
    }

    #[test]
    fn the_feature_query_is_recognised() {
        assert_eq!(events(&[b"\x1b]7501;?\x1b\\"]), [Osc7501Event::Query]);
        assert_eq!(events(&[b"\x1b]7501;?\x07"]), [Osc7501Event::Query]);
    }

    #[test]
    fn every_state_maps_to_a_thread_status() {
        use ReportedState::*;
        assert_eq!(thread_status(Working), ThreadStatus::Working);
        assert_eq!(thread_status(Blocked), ThreadStatus::NeedsInput);
        assert_eq!(thread_status(Done), ThreadStatus::Completed);
        assert_eq!(thread_status(Idle), ThreadStatus::Completed);
        assert_eq!(thread_status(Error), ThreadStatus::Error);
        assert_eq!(thread_status(Clear), ThreadStatus::Running);
    }

    #[test]
    fn malformed_records_are_ignored_and_do_not_hide_later_ones() {
        let got = events(&[
            b"\x1b]7501;\x07",
            b"\x1b]7501;state=exploding\x07",
            b"\x1b]7501;app=claude\x07",
            b"\x1b]7501;state\x07",
            b"\x1b]7501\x07",
            b"\x1b]7500;state=working\x07",
            b"\x1b]0;state=working\x07",
            b"\x1b]7501;state=\xff\xfe\x07",
            b"\x1b]7501;state=working\x1bX",
            b"\x1b]7501;state=idle\x07",
        ]);
        assert_eq!(got, [report(ReportedState::Idle)]);
    }

    #[test]
    fn an_aborted_sequence_reports_nothing() {
        assert_eq!(events(&[b"\x1b]7501;state=work\x18ing\x07"]), []);
    }

    #[test]
    fn an_overlong_sequence_is_skipped_without_growing_without_bound() {
        let mut parser = Osc7501Parser::new();
        let mut huge = b"\x1b]7501;state=working:msg=".to_vec();
        huge.extend(std::iter::repeat_n(b'A', 100_000));
        assert!(parser.feed(&huge).is_empty());
        assert!(parser.body.len() <= MAX_BODY + 1);
        // Its terminator ends the skip, and the next record is read.
        assert!(parser.feed(b"\x07").is_empty());
        assert_eq!(
            parser.feed(b"\x1b]7501;state=done\x07"),
            [report(ReportedState::Done)]
        );
    }

    #[test]
    fn a_new_sequence_starts_even_when_the_previous_never_ended() {
        let got = events(&[b"\x1b]7501;state=work\x1b]7501;state=done\x07"]);
        assert_eq!(got, [report(ReportedState::Done)]);
    }

    #[test]
    fn a_turn_runs_from_working_until_done_idle_or_error() {
        use ReportedState::*;
        let mut turns = TurnTracker::default();
        assert_eq!(turns.apply(Idle), None, "idle at startup is no Turn");
        assert_eq!(turns.apply(Working), Some(TurnChange::Started));
        assert_eq!(turns.apply(Working), None);
        assert_eq!(turns.apply(Blocked), None, "an Approval is inside the Turn");
        assert_eq!(turns.apply(Working), None);
        assert_eq!(
            turns.apply(Done),
            Some(TurnChange::Ended(TurnEnd::Completed))
        );
        assert_eq!(turns.apply(Done), None);
        assert_eq!(turns.apply(Working), Some(TurnChange::Started));
        assert_eq!(turns.apply(Error), Some(TurnChange::Ended(TurnEnd::Error)));
        assert_eq!(turns.apply(Working), Some(TurnChange::Started));
        assert_eq!(
            turns.apply(Idle),
            Some(TurnChange::Ended(TurnEnd::Completed))
        );
    }

    #[test]
    fn rapid_status_changes_are_coalesced_and_the_last_one_arrives() {
        let start = Instant::now();
        let ms = |n| start + Duration::from_millis(n);
        let mut gate = StatusGate::new(Duration::from_millis(400));
        assert_eq!(
            gate.offer(ms(0), ThreadStatus::Working),
            Some(ThreadStatus::Working)
        );
        assert_eq!(gate.offer(ms(10), ThreadStatus::NeedsInput), None);
        assert_eq!(gate.offer(ms(20), ThreadStatus::Working), None);
        assert_eq!(gate.offer(ms(30), ThreadStatus::Completed), None);
        assert_eq!(gate.due(), Some(ms(400)));
        assert_eq!(gate.flush(ms(399)), None);
        assert_eq!(gate.flush(ms(400)), Some(ThreadStatus::Completed));
        assert_eq!(gate.due(), None);
    }

    #[test]
    fn a_change_that_comes_back_to_what_is_shown_publishes_nothing() {
        let start = Instant::now();
        let mut gate = StatusGate::new(Duration::from_millis(400));
        gate.offer(start, ThreadStatus::Working);
        let at = start + Duration::from_millis(5);
        assert_eq!(gate.offer(at, ThreadStatus::Completed), None);
        assert_eq!(gate.offer(at, ThreadStatus::Working), None);
        assert_eq!(gate.flush(start + Duration::from_secs(1)), None);
        assert_eq!(gate.due(), None);
    }

    #[test]
    fn a_calm_change_goes_out_at_once() {
        let start = Instant::now();
        let mut gate = StatusGate::new(Duration::from_millis(400));
        gate.offer(start, ThreadStatus::Working);
        assert_eq!(
            gate.offer(start + Duration::from_secs(2), ThreadStatus::Completed),
            Some(ThreadStatus::Completed)
        );
    }
}
