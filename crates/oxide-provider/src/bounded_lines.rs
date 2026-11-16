//! A line reader for untrusted child-process output that never buffers more than a fixed cap.
//! `BufRead::lines` and `read_until` allocate until a newline arrives, so a child that emits one
//! endless line could exhaust memory; here a line past the cap is a clean error instead.

use std::io::{self, BufRead, ErrorKind};

/// Cap for a Provider protocol line (JSON events can carry whole file contents).
pub const PROTOCOL_LINE_CAP: usize = 16 * 1024 * 1024;

/// Cap for a log-like line: stderr, language server headers, service output.
pub const LOG_LINE_CAP: usize = 64 * 1024;

/// Whether `error` came from [`read_bounded_line`] hitting its cap.
pub fn is_line_too_long(error: &io::Error) -> bool {
    error.kind() == ErrorKind::InvalidData && error.to_string().starts_with("line exceeds")
}

/// What a Provider adapter reports when [`read_bounded_line`] stopped its stream.
pub fn protocol_overflow_message() -> String {
    format!(
        "The Provider sent a line over {} MiB, so its session was ended.",
        PROTOCOL_LINE_CAP / (1024 * 1024)
    )
}

/// Reads one line into `buf` (cleared first), without its trailing `\n` or `\r\n`. Returns
/// `Ok(false)` at end of input. A line longer than `cap` bytes fails with `InvalidData`; at most
/// `cap` bytes are ever held, and the caller should stop reading since the stream is mid-line.
pub fn read_bounded_line(
    reader: &mut impl BufRead,
    buf: &mut Vec<u8>,
    cap: usize,
) -> io::Result<bool> {
    buf.clear();
    let mut read_any = false;
    loop {
        let available = match reader.fill_buf() {
            Ok(available) => available,
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        if available.is_empty() {
            break;
        }
        read_any = true;
        let (chunk, found) = match available.iter().position(|b| *b == b'\n') {
            Some(index) => (&available[..index], Some(index + 1)),
            None => (available, None),
        };
        if buf.len() + chunk.len() > cap {
            return Err(io::Error::new(
                ErrorKind::InvalidData,
                format!("line exceeds {cap} bytes"),
            ));
        }
        buf.extend_from_slice(chunk);
        let consumed = found.unwrap_or(chunk.len());
        reader.consume(consumed);
        if found.is_some() {
            break;
        }
    }
    if buf.last() == Some(&b'\r') {
        buf.pop();
    }
    Ok(read_any)
}

/// Iterator over the lines of `reader`, lossily decoded. Ends at end of input, at an I/O error,
/// or after yielding one `Err` for a line past the cap.
pub struct BoundedLines<R> {
    reader: R,
    cap: usize,
    buf: Vec<u8>,
    done: bool,
}

impl<R: BufRead> BoundedLines<R> {
    pub fn new(reader: R, cap: usize) -> Self {
        Self {
            reader,
            cap,
            buf: Vec::new(),
            done: false,
        }
    }
}

impl<R: BufRead> Iterator for BoundedLines<R> {
    type Item = io::Result<String>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.done {
            return None;
        }
        match read_bounded_line(&mut self.reader, &mut self.buf, self.cap) {
            Ok(true) => Some(Ok(String::from_utf8_lossy(&self.buf).into_owned())),
            Ok(false) => {
                self.done = true;
                None
            }
            Err(error) => {
                self.done = true;
                Some(Err(error))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Cursor, Read};

    #[test]
    fn yields_lines_without_terminators() {
        let lines: Vec<_> = BoundedLines::new(Cursor::new("a\r\nb\n\nc"), 16)
            .map(Result::unwrap)
            .collect();
        assert_eq!(lines, ["a", "b", "", "c"]);
    }

    #[test]
    fn a_line_past_the_cap_is_an_error_and_ends_the_stream() {
        let mut lines = BoundedLines::new(Cursor::new("ok\nxxxxxxxxxx\nafter\n"), 5);
        assert_eq!(lines.next().unwrap().unwrap(), "ok");
        let error = lines.next().unwrap().unwrap_err();
        assert!(is_line_too_long(&error));
        assert!(lines.next().is_none());
    }

    #[test]
    fn a_line_of_exactly_the_cap_is_accepted() {
        let mut lines = BoundedLines::new(Cursor::new("12345\n"), 5);
        assert_eq!(lines.next().unwrap().unwrap(), "12345");
    }

    /// An endless line without a newline must stop at the cap instead of being read forever.
    #[test]
    fn memory_stays_bounded_on_an_endless_line() {
        struct Endless(usize);
        impl Read for Endless {
            fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
                self.0 += out.len();
                assert!(
                    self.0 < 10 * 1024 * 1024,
                    "reader kept consuming past the cap"
                );
                out.fill(b'x');
                Ok(out.len())
            }
        }
        let mut lines = BoundedLines::new(BufReader::new(Endless(0)), LOG_LINE_CAP);
        assert!(is_line_too_long(&lines.next().unwrap().unwrap_err()));
    }
}
