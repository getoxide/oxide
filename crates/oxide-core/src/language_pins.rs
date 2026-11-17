//! Pinned language support downloads. Oxide installs only these exact files,
//! and only after their SHA-256 matches. Update this table by pull request:
//! take the asset digests from the official release page, never from a lookup
//! made at install time.
//!
//! - clangd: <https://github.com/clangd/clangd/releases>
//! - rust-analyzer: <https://github.com/rust-lang/rust-analyzer/releases>
//! - Node.js: `SHASUMS256.txt` next to the release on <https://nodejs.org/dist/>
//!
//! `binary_sha256` is the hash of the unpacked executable, so an install that
//! already sits on disk can be checked without downloading it again.

pub const CLANGD_TAG: &str = "23.1.0";
pub const RUST_ANALYZER_TAG: &str = "2026-11-16";
pub const NODE_VERSION: &str = "v26.13.1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pin {
    pub repository: &'static str,
    pub tag: &'static str,
    pub asset: &'static str,
    pub archive_sha256: &'static str,
    pub binary_sha256: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NodePin {
    pub version: &'static str,
    pub platform: &'static str,
    pub archive: &'static str,
    pub archive_sha256: &'static str,
    /// The hash of the unpacked `node` / `node.exe`, from the official archive, so an
    /// existing install is checked before it is ever run.
    pub binary_sha256: &'static str,
}

/// `<os>-<arch>` of this build, or `None` where Oxide ships no pinned download.
pub fn platform() -> Option<&'static str> {
    let os = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        return None;
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else {
        return None;
    };
    Some(match (os, arch) {
        ("windows", "aarch64") => "windows-aarch64",
        ("windows", _) => "windows-x86_64",
        ("macos", "aarch64") => "macos-aarch64",
        ("macos", _) => "macos-x86_64",
        ("linux", "aarch64") => "linux-aarch64",
        _ => "linux-x86_64",
    })
}

const CLANGD: &str = "clangd/clangd";
const RUST_ANALYZER: &str = "rust-lang/rust-analyzer";

const fn clangd(
    asset: &'static str,
    archive_sha256: &'static str,
    binary_sha256: &'static str,
) -> Pin {
    Pin {
        repository: CLANGD,
        tag: CLANGD_TAG,
        asset,
        archive_sha256,
        binary_sha256,
    }
}

const fn rust_analyzer(
    asset: &'static str,
    archive_sha256: &'static str,
    binary_sha256: &'static str,
) -> Pin {
    Pin {
        repository: RUST_ANALYZER,
        tag: RUST_ANALYZER_TAG,
        asset,
        archive_sha256,
        binary_sha256,
    }
}

/// The pinned download of `language` ("cpp" or "rust") for `platform`.
// Upstream's Linux clangd zip is x86_64; ARM Linux uses a user-supplied server.
pub fn language_server(language: &str, platform: &str) -> Option<Pin> {
    Some(match (language, platform) {
        ("cpp", "macos-aarch64" | "macos-x86_64") => clangd(
            "clangd-mac-23.1.0.zip",
            "1082e6638223b785ca2daf0939f13afcd0bb95c84ee9a4bbaff4745365159253",
            "23197c85e1fbe16de89666bb6d1132b36b02213906b09e12d687eda8cc3b6a57",
        ),
        ("cpp", "linux-x86_64") => clangd(
            "clangd-linux-23.1.0.zip",
            "e53b1a96196095faedb7642cf64964f7fb9ad4a0c1f00dd2c172a3d9dcbafdfd",
            "5a535973dd1274270c8a0d34677fe4758d8c9aaa164aa3701602c957c42dc9e2",
        ),
        ("cpp", "windows-aarch64" | "windows-x86_64") => clangd(
            "clangd-windows-23.1.0.zip",
            "23412a240756a162e7b98a282f36aa2a23a88db5ce16a0cbc4fef7253768c810",
            "dbd52c13d21ef9d284f4f0627efe76c81adf2fe0998f230127f554a54fc9dde7",
        ),
        ("rust", "macos-aarch64") => rust_analyzer(
            "rust-analyzer-aarch64-apple-darwin.gz",
            "608b7c7d6bec1fcd6c964578b1f8234888afe6d6c0e7915284f1e2fd36ef1343",
            "014f9105bd799e903172a6d7410ab9db2749602cdb43cbb024d45002ccf5cb49",
        ),
        ("rust", "macos-x86_64") => rust_analyzer(
            "rust-analyzer-x86_64-apple-darwin.gz",
            "6901d956b4f2b091343eaf3570944098488f3ffec018987145285ed8253c07d2",
            "c59149cac64fb9f20bd406522c3f0e3b08ce000aefd7b7af93ea808198982064",
        ),
        ("rust", "linux-aarch64") => rust_analyzer(
            "rust-analyzer-aarch64-unknown-linux-gnu.gz",
            "73d8b9b87384b3115a183a8a51db9f7c205ce4c89ea511f3c8c8fea863038a50",
            "c92847a5a8b72481dc95c116bb5f807c9dfb7bcb15952f0bc5878f97d7883317",
        ),
        ("rust", "linux-x86_64") => rust_analyzer(
            "rust-analyzer-x86_64-unknown-linux-gnu.gz",
            "4a08727a03094e5114db4438e4bd1d6182cc26eff37d6962115ea1ec1a491ca3",
            "750a6955ef2fdc3d6a685e7e5bea5e17d7f60fcc5b39854751112c23f532cf81",
        ),
        ("rust", "windows-aarch64") => rust_analyzer(
            "rust-analyzer-aarch64-pc-windows-msvc.zip",
            "2e8fd876300eeee87afd6de18c79eb17bab425a9b755043c63d5023d58de37b7",
            "b0489a7cb455dd42a9452005c6d6b72a7a3a880496b544e791d8f3c640359622",
        ),
        ("rust", "windows-x86_64") => rust_analyzer(
            "rust-analyzer-x86_64-pc-windows-msvc.zip",
            "dbf0c36ec54cf727d34cc40c9994fe71b7d52e3c28a3112c3deca1aba46fbc8f",
            "f56badfe792f31a4d211fff5d98822a9f3a84f198ffc3d68fc63a4a4e6d8d74a",
        ),
        _ => return None,
    })
}

/// The pinned Node.js runtime for `platform`.
pub fn node(platform: &str) -> Option<NodePin> {
    let (name, archive, archive_sha256, binary_sha256) = match platform {
        "macos-aarch64" => (
            "darwin-arm64",
            "node-v26.13.1-darwin-arm64.tar.gz",
            "aec2514ea1ceb2ba52455e9ec65986f6749a06dd759e5db2a72e6889668c9735",
            "266dec4dce3a6cdcf5cdc38722a00cf5ae6a12cc51068d2a227655bbb75751ec",
        ),
        "macos-x86_64" => (
            "darwin-x64",
            "node-v26.13.1-darwin-x64.tar.gz",
            "82bb96078a24ca50b9c9a38f2379e6be6d87171fcd400fc14c8934b3bce96e2f",
            "e85cb6dd5f916a2aa0d05a5874dcf7c69b1ebd7a5347d7ff912bb4d9339f5e23",
        ),
        "linux-aarch64" => (
            "linux-arm64",
            "node-v26.13.1-linux-arm64.tar.gz",
            "80a330b35415382878df18d41afbd106ea89bfb3be0087d6608e289a14c5cc7d",
            "de21e5b6e081aa16f86413aeba8c77fac44670cb6fe2748cc7c00329e6e6aa3a",
        ),
        "linux-x86_64" => (
            "linux-x64",
            "node-v26.13.1-linux-x64.tar.gz",
            "518674de2b621728a5e4486f5fb3b7d2900bb3cc4aa97969edaa463db99f9778",
            "d931c649850ffa7155b8ceffb400dc916ef325866e509cc52ae36e33e8fbb9a9",
        ),
        "windows-aarch64" => (
            "win-arm64",
            "node-v26.13.1-win-arm64.zip",
            "181ebe431b90787113a9e4fc80d38ce86d37888a353a0386de44d2872e48cb97",
            "00edc356a01d7fe586beebe7519bb1acdff9dd62064ce4cf12ff1ed4a8d1810e",
        ),
        "windows-x86_64" => (
            "win-x64",
            "node-v26.13.1-win-x64.zip",
            "e2edda75bfb089654705cf65a13b58933bfd5f57148e8ebda916f58a2474f1f7",
            "f5109dc868ec38703ad8f305e0aceece717cb60d4889873f434017af4e96cccb",
        ),
        _ => return None,
    };
    Some(NodePin {
        version: NODE_VERSION,
        platform: name,
        archive,
        archive_sha256,
        binary_sha256,
    })
}

impl Pin {
    pub fn url(&self) -> String {
        format!(
            "https://github.com/{}/releases/download/{}/{}",
            self.repository, self.tag, self.asset
        )
    }
}

impl NodePin {
    pub fn url(&self) -> String {
        format!("https://nodejs.org/dist/{}/{}", self.version, self.archive)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const PLATFORMS: [&str; 6] = [
        "macos-aarch64",
        "macos-x86_64",
        "linux-aarch64",
        "linux-x86_64",
        "windows-aarch64",
        "windows-x86_64",
    ];
    fn is_sha256(value: &str) -> bool {
        value.len() == 64
            && value
                .chars()
                .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
    }
    #[test]
    fn every_pin_is_a_well_formed_hash_for_the_pinned_version() {
        let mut found = 0;
        for platform in PLATFORMS {
            for language in ["cpp", "rust"] {
                if let Some(pin) = language_server(language, platform) {
                    found += 1;
                    assert!(is_sha256(pin.archive_sha256), "{}", pin.asset);
                    assert!(is_sha256(pin.binary_sha256), "{}", pin.asset);
                    assert_ne!(pin.archive_sha256, pin.binary_sha256);
                    assert!(pin.url().starts_with(&format!(
                        "https://github.com/{}/releases/download/{}/",
                        pin.repository, pin.tag
                    )));
                    assert!(!pin.tag.is_empty() && pin.tag != "latest");
                }
            }
            let node = node(platform).expect("node is pinned on every platform");
            assert!(is_sha256(node.archive_sha256));
            assert!(is_sha256(node.binary_sha256));
            assert_ne!(node.archive_sha256, node.binary_sha256);
            assert!(node.archive.starts_with(&format!("node-{}-", node.version)));
            assert!(node.archive.contains(node.platform));
        }
        assert_eq!(found, 6 + 5);
    }
    #[test]
    fn only_platforms_with_an_official_binary_are_pinned() {
        assert!(language_server("cpp", "linux-aarch64").is_none());
        assert!(language_server("rust", "freebsd-x86_64").is_none());
        assert!(language_server("python", "macos-aarch64").is_none());
    }
}
