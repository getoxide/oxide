//! User-local language support, downloaded only after an explicit Install action.
use crate::language_pins as pins;
use crate::{Error, LanguageServerConfig, Result};
use reqwest::blocking::Client;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

const MAX_DOWNLOAD: u64 = 400 * 1024 * 1024;
const NO_CHECKSUM: &str = "Oxide has no verified checksum for this download, so it will not install it. Set a custom executable in Language tools.";
#[allow(clippy::needless_pass_by_value)]
fn error(message: impl ToString) -> Error {
    Error::Editor(message.to_string())
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn install(home: &Path, language: &str, progress: &impl Fn(&str)) -> Result<()> {
    let tools = home.join("tools");
    std::fs::create_dir_all(&tools).map_err(error)?;
    let temporary = tempfile::tempdir_in(&tools).map_err(error)?;
    let client = Client::builder()
        .user_agent("Oxide-language-support/0.1")
        .timeout(Duration::from_secs(300))
        .https_only(true)
        .build()
        .map_err(error)?;
    progress("Preparing language support…");
    let previous = crate::language_server::tools(home)
        .into_iter()
        .find(|t| t.language == language);
    let interpreter = previous.and_then(|t| t.config.interpreter);
    let (command, args) = match language {
        "python" | "typescript" => {
            install_npm(&client, home, temporary.path(), language, progress)?;
            let name = if language == "python" {
                "pyright-langserver"
            } else {
                "typescript-language-server"
            };
            let shim = if cfg!(windows) {
                format!("{name}.cmd")
            } else {
                name.into()
            };
            (
                home.join("tools/language-servers")
                    .join(language)
                    .join("node_modules/.bin")
                    .join(shim),
                vec!["--stdio".into()],
            )
        }
        "cpp" | "rust" => {
            let executable = if language == "cpp" {
                "clangd"
            } else {
                "rust-analyzer"
            };
            let executable_name = if cfg!(windows) {
                format!("{executable}.exe")
            } else {
                executable.into()
            };
            let pin = pins::platform()
                .and_then(|platform| pins::language_server(language, platform))
                .ok_or_else(|| error("No official binary is available for this operating system / architecture. Set a custom executable in Language tools."))?;
            let destination = tools.join(executable).join(pin.tag);
            let binary = if let Some(binary) =
                reusable_install(&destination, &executable_name, pin.binary_sha256)
            {
                binary
            } else {
                let archive = temporary.path().join(pin.asset);
                download(
                    &client,
                    &pin.url(),
                    &archive,
                    Some(pin.archive_sha256),
                    progress,
                )?;
                progress("Unpacking language support…");
                let extracted = temporary.path().join("unpacked");
                std::fs::create_dir_all(&extracted).map_err(error)?;
                if pin.asset.ends_with(".zip") {
                    extract_zip(&archive, &extracted)?;
                } else {
                    gunzip_limited(&archive, &extracted.join(executable), MAX_DOWNLOAD)?;
                }
                let found = find_executable(&extracted, &executable_name, 5).ok_or_else(|| {
                    error("The download did not contain the language server executable.")
                })?;
                if !file_matches(&found, pin.binary_sha256) {
                    return Err(error(
                        "The unpacked language server failed checksum verification. Nothing was installed. Set a custom executable in Language tools.",
                    ));
                }
                let relative = found.strip_prefix(&extracted).map_err(error)?.to_path_buf();
                std::fs::create_dir_all(destination.parent().unwrap()).map_err(error)?;
                std::fs::rename(&extracted, &destination).map_err(error)?;
                destination.join(relative)
            };
            make_executable(&binary)?;
            (binary, vec![])
        }
        _ => return Err(error("Unsupported language support.")),
    };
    if !command.is_file() {
        return Err(error(
            "Installation did not create the language server. Check your connection and try again.",
        ));
    }
    crate::language_server::configure(
        home,
        language,
        LanguageServerConfig {
            command: command.to_string_lossy().into_owned(),
            args,
            interpreter,
        },
    )?;
    progress("Installed. Connecting to your open files…");
    Ok(())
}

fn download(
    client: &Client,
    url: &str,
    destination: &Path,
    expected: Option<&str>,
    progress: &impl Fn(&str),
) -> Result<()> {
    let Some(expected) = expected else {
        return Err(error(NO_CHECKSUM));
    };
    let mut response = client
        .get(url)
        .send()
        .map_err(error)?
        .error_for_status()
        .map_err(error)?;
    if response.content_length().is_some_and(|n| n > MAX_DOWNLOAD) {
        return Err(error("Download is larger than the supported limit."));
    }
    let total = response.content_length();
    let mut received = 0;
    let mut announced = 0;
    let mut hash = Sha256::new();
    let mut file = File::create(destination).map_err(error)?;
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = response.read(&mut buffer).map_err(error)?;
        if count == 0 {
            break;
        }
        received += count as u64;
        if received > MAX_DOWNLOAD {
            return Err(error("Download exceeded the supported limit."));
        }
        file.write_all(&buffer[..count]).map_err(error)?;
        hash.update(&buffer[..count]);
        if received - announced >= 2 * 1024 * 1024 {
            announced = received;
            progress(&match total {
                Some(total) if total > 0 => format!("Downloading… {}%", received * 100 / total),
                _ => format!("Downloading… {} MiB", received / 1024 / 1024),
            });
        }
    }
    drop(file);
    if !hex(&hash.finalize()).eq_ignore_ascii_case(expected) {
        let _ = std::fs::remove_file(destination);
        return Err(error(
            "The downloaded file failed checksum verification. Nothing was installed. Set a custom executable in Language tools.",
        ));
    }
    Ok(())
}

/// Returns the binary of an existing install only if its SHA-256 equals the
/// pinned one. Anything else (tampered, partial) is removed so it is reinstalled.
fn reusable_install(destination: &Path, executable_name: &str, expected: &str) -> Option<PathBuf> {
    if !destination.exists() {
        return None;
    }
    let matching = find_executable(destination, executable_name, 5)
        .filter(|binary| file_matches(binary, expected));
    if matching.is_none() {
        let _ = std::fs::remove_dir_all(destination);
    }
    matching
}

fn file_matches(path: &Path, expected: &str) -> bool {
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => hash.update(&buffer[..n]),
            Err(_) => return false,
        }
    }
    hex(&hash.finalize()).eq_ignore_ascii_case(expected)
}

/// Decompresses a gzip file to `destination`. A stream that goes past `limit`
/// bytes is an error and leaves no file, never a silently truncated binary.
fn gunzip_limited(archive: &Path, destination: &Path, limit: u64) -> Result<()> {
    let reader = flate2::read::GzDecoder::new(File::open(archive).map_err(error)?);
    let mut file = File::create(destination).map_err(error)?;
    let copied = std::io::copy(&mut reader.take(limit.saturating_add(1)), &mut file);
    drop(file);
    match copied {
        Ok(n) if n <= limit => Ok(()),
        outcome => {
            let _ = std::fs::remove_file(destination);
            match outcome {
                Ok(_) => Err(error(
                    "Unpacked language server is larger than the supported limit.",
                )),
                Err(e) => Err(error(e)),
            }
        }
    }
}

fn extract_zip(archive: &Path, root: &Path) -> Result<()> {
    let mut zip = zip::ZipArchive::new(File::open(archive).map_err(error)?).map_err(error)?;
    let mut total: u64 = 0;
    if zip.len() > 30000 {
        return Err(error("Archive contains too many files."));
    }
    for n in 0..zip.len() {
        let mut entry = zip.by_index(n).map_err(error)?;
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| error("Archive path leaves the installation directory."))?;
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(error("Archive contains a symbolic link."));
        }
        total = total.saturating_add(entry.size());
        if total > 1024 * 1024 * 1024 {
            return Err(error("Expanded archive exceeds 1 GiB."));
        }
        let target = root.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&target).map_err(error)?;
        } else {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(error)?;
            }
            let mut file = File::create(&target).map_err(error)?;
            std::io::copy(&mut entry, &mut file).map_err(error)?;
        }
    }
    Ok(())
}
fn find_executable(root: &Path, name: &str, depth: usize) -> Option<PathBuf> {
    if depth == 0 {
        return None;
    }
    for entry in std::fs::read_dir(root).ok()?.flatten() {
        let path = entry.path();
        if path.is_file() && entry.file_name() == name {
            return Some(path);
        }
        if path.is_dir()
            && let Some(found) = find_executable(&path, name, depth - 1)
        {
            return Some(found);
        }
    }
    None
}
#[cfg_attr(not(unix), allow(clippy::unnecessary_wraps))]
fn make_executable(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).map_err(error)?;
    }
    let _ = path;
    Ok(())
}

/// The package set Oxide ships for a Node-based language server: a
/// `package.json` and the `package-lock.json` that fixes every transitive
/// version and integrity hash. Regenerate with
/// `npm install --package-lock-only --ignore-scripts` and review the diff.
fn package_set(language: &str) -> Option<(&'static str, &'static str)> {
    match language {
        "python" => Some((
            include_str!("../assets/language-servers/python/package.json"),
            include_str!("../assets/language-servers/python/package-lock.json"),
        )),
        "typescript" => Some((
            include_str!("../assets/language-servers/typescript/package.json"),
            include_str!("../assets/language-servers/typescript/package-lock.json"),
        )),
        _ => None,
    }
}

fn write_package_set(prefix: &Path, language: &str) -> Result<()> {
    let (manifest, lockfile) =
        package_set(language).ok_or_else(|| error("Unsupported language support."))?;
    std::fs::create_dir_all(prefix).map_err(error)?;
    std::fs::write(prefix.join("package.json"), manifest).map_err(error)?;
    std::fs::write(prefix.join("package-lock.json"), lockfile).map_err(error)?;
    Ok(())
}

/// `npm ci` installs exactly what the lockfile says and fails when it does not
/// match; `--ignore-scripts` keeps third-party install scripts from running.
const NPM_ARGUMENTS: [&str; 4] = ["ci", "--ignore-scripts", "--no-audit", "--no-fund"];

fn install_npm(
    client: &Client,
    home: &Path,
    temporary: &Path,
    language: &str,
    progress: &impl Fn(&str),
) -> Result<()> {
    let node_root = home.join("tools/node");
    let managed_node = node_root.join(if cfg!(windows) {
        "node.exe"
    } else {
        "bin/node"
    });
    let path = std::env::var_os("PATH").unwrap_or_default();
    let system_npm = oxide_provider::command::find_in(
        &path,
        std::ffi::OsStr::new("npm"),
        std::env::var_os("PATHEXT").as_deref(),
    );
    if !managed_node.exists() && system_npm.is_none() {
        progress("Installing a private Node.js runtime for language tools…");
        let pin = pins::platform()
            .and_then(pins::node)
            .ok_or_else(|| error("Set a custom language server on this architecture."))?;
        let archive = temporary.join(pin.archive);
        download(
            client,
            &pin.url(),
            &archive,
            Some(pin.archive_sha256),
            progress,
        )?;
        let extracted = temporary.join("node");
        std::fs::create_dir_all(&extracted).map_err(error)?;
        if cfg!(windows) {
            extract_zip(&archive, &extracted)?;
        } else {
            tar::Archive::new(flate2::read::GzDecoder::new(
                File::open(&archive).map_err(error)?,
            ))
            .unpack(&extracted)
            .map_err(error)?;
        }
        let source = extracted.join(format!("node-{}-{}", pin.version, pin.platform));
        std::fs::rename(source, &node_root).map_err(error)?;
        make_executable(&managed_node)?;
    }
    progress("Installing language packages…");
    let prefix = home.join("tools/language-servers").join(language);
    write_package_set(&prefix, language)?;
    let mut command = if managed_node.exists() {
        let npm = node_root.join(if cfg!(windows) {
            "node_modules/npm/bin/npm-cli.js"
        } else {
            "lib/node_modules/npm/bin/npm-cli.js"
        });
        let mut command = Command::new(&managed_node);
        command.arg(npm);
        command
    } else {
        Command::new(system_npm.ok_or_else(|| error("npm was not found."))?)
    };
    // Run inside the prefix: npm resolves the project from the working directory.
    command.args(NPM_ARGUMENTS).current_dir(&prefix);
    let mut paths = vec![node_root.clone(), node_root.join("bin")];
    paths.extend(std::env::split_paths(&path));
    command.env("PATH", std::env::join_paths(paths).map_err(error)?);
    let output = oxide_provider::process::output_in_own_group(&mut command).map_err(error)?;
    if !output.status.success() {
        return Err(error(format!(
            "Language package installation failed: {}",
            String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(4000)
                .collect::<String>()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn zip_extraction_rejects_paths_outside_install_root() {
        let temporary = tempfile::tempdir().unwrap();
        let archive = temporary.path().join("bad.zip");
        let mut writer = zip::ZipWriter::new(File::create(&archive).unwrap());
        writer
            .start_file("../escape", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"no").unwrap();
        writer.finish().unwrap();
        assert!(extract_zip(&archive, &temporary.path().join("extract")).is_err());
        assert!(!temporary.path().parent().unwrap().join("escape").exists());
    }
    #[test]
    fn node_packages_install_from_the_lockfile_without_running_scripts() {
        let arguments = NPM_ARGUMENTS;
        assert_eq!(arguments[0], "ci");
        assert!(arguments.contains(&"--ignore-scripts"));
        assert!(!arguments.contains(&"install"));
    }
    #[test]
    fn shipped_lockfiles_pin_every_package_with_an_integrity_hash() {
        for language in ["python", "typescript"] {
            let (manifest, lockfile) = package_set(language).unwrap();
            let manifest: serde_json::Value = serde_json::from_str(manifest).unwrap();
            let lock: serde_json::Value = serde_json::from_str(lockfile).unwrap();
            assert_eq!(lock["lockfileVersion"], 3);
            // The lockfile root must declare the same dependencies as the manifest.
            assert_eq!(
                lock["packages"][""]["dependencies"],
                manifest["dependencies"]
            );
            let packages = lock["packages"].as_object().unwrap();
            assert!(packages.len() > 1);
            for (name, package) in packages.iter().filter(|(name, _)| !name.is_empty()) {
                assert!(
                    package["resolved"]
                        .as_str()
                        .is_some_and(|url| url.starts_with("https://registry.npmjs.org/")),
                    "{language}: {name} is not pinned to the npm registry"
                );
                assert!(
                    package["integrity"]
                        .as_str()
                        .is_some_and(|hash| hash.starts_with("sha512-")),
                    "{language}: {name} has no integrity hash"
                );
            }
        }
    }
    /// Hits the network: `cargo nextest run -p oxide-core --run-ignored only language_install`.
    #[test]
    #[ignore = "downloads the pinned language servers"]
    fn live_install_of_each_pinned_language_server_then_reuse() {
        for language in ["rust", "cpp", "typescript"] {
            let home = tempfile::tempdir().unwrap();
            install(home.path(), language, &|_| {}).unwrap();
            let tool = crate::language_server::tools(home.path())
                .into_iter()
                .find(|t| t.language == language)
                .unwrap();
            assert!(Path::new(&tool.config.command).is_file(), "{language}");
            // A second install reuses the verified destination.
            install(home.path(), language, &|_| {}).unwrap();
        }
    }
    #[test]
    fn no_package_set_exists_for_other_languages() {
        assert!(package_set("rust").is_none());
    }
    fn fake_install(destination: &Path, content: &[u8]) -> PathBuf {
        let binary = destination.join("bin/tool");
        std::fs::create_dir_all(binary.parent().unwrap()).unwrap();
        std::fs::write(&binary, content).unwrap();
        binary
    }
    #[test]
    fn an_existing_install_is_reused_only_when_its_binary_matches_the_pin() {
        let temporary = tempfile::tempdir().unwrap();
        let destination = temporary.path().join("1.0");
        let binary = fake_install(&destination, b"hello");
        assert_eq!(
            reusable_install(&destination, "tool", HELLO_SHA256),
            Some(binary)
        );
    }
    #[test]
    fn a_tampered_existing_install_is_removed_so_it_gets_reinstalled() {
        let temporary = tempfile::tempdir().unwrap();
        let destination = temporary.path().join("1.0");
        fake_install(&destination, b"tampered");
        assert_eq!(reusable_install(&destination, "tool", HELLO_SHA256), None);
        assert!(!destination.exists());
    }
    #[test]
    fn an_install_without_the_binary_is_removed_too() {
        let temporary = tempfile::tempdir().unwrap();
        let destination = temporary.path().join("1.0");
        std::fs::create_dir_all(&destination).unwrap();
        assert_eq!(reusable_install(&destination, "tool", HELLO_SHA256), None);
        assert!(!destination.exists());
    }
    fn gzip(data: &[u8]) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(data).unwrap();
        encoder.finish().unwrap()
    }
    #[test]
    fn gzip_over_the_cap_fails_instead_of_truncating() {
        let temporary = tempfile::tempdir().unwrap();
        let archive = temporary.path().join("big.gz");
        std::fs::write(&archive, gzip(&[7; 100])).unwrap();
        let output = temporary.path().join("out");
        assert!(gunzip_limited(&archive, &output, 99).is_err());
        assert!(!output.exists());
    }
    #[test]
    fn gzip_exactly_at_the_cap_is_extracted_whole() {
        let temporary = tempfile::tempdir().unwrap();
        let archive = temporary.path().join("ok.gz");
        std::fs::write(&archive, gzip(&[7; 100])).unwrap();
        let output = temporary.path().join("out");
        gunzip_limited(&archive, &output, 100).unwrap();
        assert_eq!(std::fs::read(&output).unwrap(), vec![7; 100]);
    }
    /// Serves `body` once over plain HTTP and returns the URL.
    fn serve_once(body: &'static [u8]) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut request = [0; 1024];
                let _ = stream.read(&mut request);
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(body);
            }
        });
        format!("http://127.0.0.1:{port}/asset")
    }
    const HELLO_SHA256: &str = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    #[test]
    fn download_without_an_expected_checksum_fails_and_keeps_nothing() {
        let temporary = tempfile::tempdir().unwrap();
        let target = temporary.path().join("asset");
        let result = download(
            &Client::new(),
            &serve_once(b"hello"),
            &target,
            None,
            &|_| {},
        );
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("custom executable")
        );
        assert!(!target.exists());
    }
    #[test]
    fn download_with_a_mismatched_checksum_fails_and_keeps_nothing() {
        let temporary = tempfile::tempdir().unwrap();
        let target = temporary.path().join("asset");
        let wrong = "0".repeat(64);
        let result = download(
            &Client::new(),
            &serve_once(b"hello"),
            &target,
            Some(&wrong),
            &|_| {},
        );
        assert!(result.unwrap_err().to_string().contains("checksum"));
        assert!(!target.exists());
    }
    #[test]
    fn download_with_the_expected_checksum_succeeds() {
        let temporary = tempfile::tempdir().unwrap();
        let target = temporary.path().join("asset");
        download(
            &Client::new(),
            &serve_once(b"hello"),
            &target,
            Some(HELLO_SHA256),
            &|_| {},
        )
        .unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"hello");
    }
}
