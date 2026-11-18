/// The `explorer /select,` argument for `path`, quoted whole so a comma in a folder name cannot
/// split it into several arguments. Pure text, so every OS tests it.
#[cfg_attr(
    not(windows),
    allow(dead_code, reason = "used by the Windows implementation")
)]
pub(crate) fn select_arg(path: &str) -> String {
    format!("/select,\"{}\"", path.replace('/', "\\"))
}

#[cfg(test)]
mod tests {
    use super::select_arg;

    #[test]
    fn explorer_receives_the_path_as_one_quoted_argument() {
        assert_eq!(
            select_arg("C:/Users/me/a, b/file.txt"),
            "/select,\"C:\\Users\\me\\a, b\\file.txt\""
        );
    }
}
