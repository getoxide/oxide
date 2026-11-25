//! Images embedded in issue and pull request text: the signed URLs that make private
//! `user-attachments` readable without the user's token.

use super::Gh;
use crate::{Error, Result};
use base64::Engine as _;
use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::time::Duration;

/// The short-lived signed URL GitHub rendered for an uploaded asset, which loads without the
/// user's token. The asset is named by its uuid, the last segment of both
/// `https://github.com/user-attachments/assets/<uuid>` and a private repository's
/// `https://github.com/<owner>/<repo>/assets/<n>/<uuid>`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedImage {
    pub asset_id: String,
    pub signed_url: String,
}

const SIGNED_HOST: &str = "private-user-images.githubusercontent.com";

/// The `src` of every `<img>` tag in `html`, entity-decoded. Text extraction only: the HTML
/// itself never leaves Core.
fn image_sources(html: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(at) = lower.get(from..).and_then(|rest| rest.find("<img")) {
        let start = from + at;
        let end = lower
            .get(start..)
            .and_then(|rest| rest.find('>'))
            .map_or(lower.len(), |e| start + e);
        from = end;
        let (Some(tag), Some(tag_lower)) = (html.get(start..end), lower.get(start..end)) else {
            break;
        };
        let mut search = 0;
        while let Some(i) = tag_lower.get(search..).and_then(|r| r.find("src=")) {
            let i = search + i;
            search = i + 4;
            if !tag_lower[..i].ends_with(|c: char| c.is_ascii_whitespace()) {
                continue;
            }
            let value = &tag[i + 4..];
            let Some(quote) = value.chars().next().filter(|c| *c == '"' || *c == '\'') else {
                break;
            };
            if let Some(close) = value[1..].find(quote) {
                out.push(decode_entities(&value[1..=close]));
            }
            break;
        }
    }
    out
}

fn decode_entities(value: &str) -> String {
    value
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// The asset id in a signed URL's last segment, `<number>-<uuid>.<ext>`.
fn asset_id(signed: &url::Url) -> Option<&str> {
    let name = signed.path_segments()?.next_back()?;
    let (_, rest) = name.split_once('-')?;
    let id = rest.split('.').next()?;
    (id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')).then_some(id)
}

/// Adds to `out` the user attachments `html` (GitHub's `bodyHTML`) has signed URLs for.
pub(super) fn signed_images(html: &str, out: &mut Vec<SignedImage>) {
    for src in image_sources(html) {
        let Ok(signed) = url::Url::parse(&src) else {
            continue;
        };
        if signed.scheme() != "https"
            || signed.host_str() != Some(SIGNED_HOST)
            || signed.port().is_some()
            || !signed.username().is_empty()
            || signed.password().is_some()
        {
            continue;
        }
        let Some(id) = asset_id(&signed) else {
            continue;
        };
        let id = id.to_ascii_lowercase();
        if out.iter().all(|image| image.asset_id != id) {
            out.push(SignedImage {
                asset_id: id,
                signed_url: src,
            });
        }
    }
}

/// The largest image Oxide reads, checked before anything is allocated for it.
pub(super) const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;
/// Signed URLs carry a JWT, so they are long, but not this long.
const MAX_URL: usize = 4096;
const TIMEOUT: Duration = Duration::from_secs(15);
const MAX_REDIRECTS: usize = 5;

/// The hosts an image may be read from. `github.com` is further limited by [`github_path`].
const IMAGE_HOSTS: &[&str] = &[
    "github.com",
    "user-images.githubusercontent.com",
    SIGNED_HOST,
    "raw.githubusercontent.com",
    "camo.githubusercontent.com",
    "avatars.githubusercontent.com",
    "objects.githubusercontent.com",
    "media.githubusercontent.com",
    "release-assets.githubusercontent.com",
];

fn refused() -> Error {
    Error::Github("Oxide only shows images hosted on GitHub.".into())
}

fn failed() -> Error {
    Error::Github("GitHub did not send the image.".into())
}

/// A URL with `https`, no userinfo, the default port and a named host: the shape every request
/// and every redirect must have.
fn plain_https(url: &url::Url) -> Option<&str> {
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return None;
    }
    match url.host()? {
        url::Host::Domain(host) => Some(host),
        url::Host::Ipv4(_) | url::Host::Ipv6(_) => None,
    }
}

/// On `github.com`, only attachments and a repository's assets and raw files are images.
fn github_path(url: &url::Url) -> bool {
    let segments: Vec<&str> = url
        .path_segments()
        .map(Iterator::collect)
        .unwrap_or_default();
    match segments.as_slice() {
        ["user-attachments", kind, ..] => !kind.is_empty(),
        [owner, repo, "assets" | "raw", first, ..] => {
            !owner.is_empty() && !repo.is_empty() && !first.is_empty()
        }
        _ => false,
    }
}

fn allowed_image_url(url: &url::Url) -> bool {
    match plain_https(url) {
        Some("github.com") => github_path(url),
        Some(host) => IMAGE_HOSTS.contains(&host),
        None => false,
    }
}

/// An image URL the webview asked for: well-formed, `https`, on a GitHub image host.
fn checked_image_url(url: &str) -> Result<url::Url> {
    if url.is_empty()
        || url.len() > MAX_URL
        || url.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(refused());
    }
    let parsed = url::Url::parse(url).map_err(|_| refused())?;
    if allowed_image_url(&parsed) {
        Ok(parsed)
    } else {
        Err(refused())
    }
}

/// Where a redirect may lead: another GitHub image host, or one of the storage buckets
/// GitHub serves its assets from. The first request is always to a GitHub host, so a bucket
/// is only ever reached from GitHub.
fn allowed_hop(url: &url::Url) -> bool {
    match plain_https(url) {
        Some(host) => {
            allowed_image_url(url)
                || host
                    .strip_suffix(".s3.amazonaws.com")
                    .is_some_and(|bucket| bucket.starts_with("github-") && !bucket.contains('.'))
        }
        None => false,
    }
}

/// The type of a raster image, told by its first bytes; `None` for anything else, notably
/// SVG and HTML, which can carry script.
fn raster_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else if matches!(bytes.get(4..12), Some(b"ftypavif" | b"ftypavis")) {
        Some("image/avif")
    } else {
        None
    }
}

fn data_url(bytes: &[u8]) -> Result<String> {
    let mime = raster_mime(bytes)
        .ok_or_else(|| Error::Github("That file is not an image Oxide shows.".into()))?;
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

fn too_large() -> Error {
    Error::Github("That image is too large to show.".into())
}

/// Reads at most [`MAX_IMAGE_BYTES`]: a declared length over the cap is refused before
/// reading, and a body longer than the cap is refused whatever its declared length.
fn read_capped(reader: impl Read, content_length: Option<u64>) -> Result<Vec<u8>> {
    if content_length.is_some_and(|length| length > MAX_IMAGE_BYTES) {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    reader
        .take(MAX_IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| failed())?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(too_large());
    }
    Ok(bytes)
}

enum Response {
    Body(Vec<u8>),
    NotFound,
}

/// One `GET` without credentials: no cookies, no token, every redirect checked.
fn http_get(url: &url::Url) -> Result<Response> {
    let policy = reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= MAX_REDIRECTS {
            attempt.error("too many redirects")
        } else if allowed_hop(attempt.url()) {
            attempt.follow()
        } else {
            attempt.error("redirected away from GitHub")
        }
    });
    let client = reqwest::blocking::Client::builder()
        .user_agent("Oxide-images/0.1")
        .https_only(true)
        .connect_timeout(TIMEOUT)
        .timeout(TIMEOUT)
        .redirect(policy)
        .build()
        .map_err(|_| failed())?;
    let response = client.get(url.as_str()).send().map_err(|_| failed())?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(Response::NotFound);
    }
    if !status.is_success() {
        return Err(failed());
    }
    let length = response.content_length();
    read_capped(response, length).map(Response::Body)
}

/// The `gh api` contents endpoint for a raw file on `raw.githubusercontent.com` or
/// `github.com/<owner>/<repo>/raw/`: `repos/<owner>/<repo>/contents/<path>?ref=<ref>`.
fn raw_endpoint(url: &url::Url) -> Option<String> {
    if url.query().is_some() || url.fragment().is_some() {
        return None;
    }
    let segments: Vec<&str> = url.path_segments()?.collect();
    let rest = match (plain_https(url)?, segments.as_slice()) {
        ("raw.githubusercontent.com", [owner, repo, rest @ ..]) => (*owner, *repo, rest),
        ("github.com", [owner, repo, "raw", rest @ ..]) => (*owner, *repo, rest),
        _ => return None,
    };
    let (owner, repo, rest) = rest;
    let (reference, path) = match rest {
        ["refs", "heads" | "tags", reference, path @ ..] => (*reference, path),
        [reference, path @ ..] => (*reference, path),
        [] => return None,
    };
    let name = |s: &str| {
        !s.is_empty()
            && !s.starts_with(['-', '.'])
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    };
    let segment = |s: &&str| {
        !s.is_empty()
            && *s != "."
            && *s != ".."
            && s.bytes().all(|b| {
                b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~' | b'%' | b'+')
            })
    };
    (name(owner)
        && name(repo)
        && segment(&reference)
        && !path.is_empty()
        && path.iter().all(segment))
    .then(|| {
        format!(
            "repos/{owner}/{repo}/contents/{}?ref={reference}",
            path.join("/")
        )
    })
}

/// A raw file of a private repository, read through `gh` so the token never leaves it.
fn raw_via_gh(gh: &Gh, cwd: &Path, url: &url::Url) -> Result<Vec<u8>> {
    let endpoint = raw_endpoint(url).ok_or_else(failed)?;
    gh.require_ready(cwd)?;
    gh.run_bounded(
        cwd,
        &["api", &endpoint, "-H", "Accept: application/vnd.github.raw"],
        MAX_IMAGE_BYTES,
    )
    .map_err(|_| failed())
}

fn fetch_with(
    url: &url::Url,
    get: impl FnOnce(&url::Url) -> Result<Response>,
    raw: impl FnOnce(&url::Url) -> Result<Vec<u8>>,
) -> Result<String> {
    let bytes = match get(url)? {
        Response::Body(bytes) => bytes,
        Response::NotFound if raw_endpoint(url).is_some() => raw(url)?,
        Response::NotFound => return Err(failed()),
    };
    data_url(&bytes)
}

/// An image embedded in an issue or pull request, as a `data:` URL the webview can show under
/// its existing Content Security Policy.
///
/// Network access: one `GET` to a GitHub image host (HTTPS only, no userinfo, default port, a
/// fixed host allowlist, `github.com` only for attachments and repository assets), with no
/// cookies or token, at most 5 redirects each checked against the same allowlist plus GitHub's
/// asset buckets, a 15 s timeout and a 5 MiB cap enforced before reading. A raw file that answers
/// 404 is read once more through `gh api` (the user's token stays inside `gh`), output bounded
/// the same way. Only PNG, JPEG, GIF, WebP and AVIF bytes are returned; SVG, HTML and anything
/// else is refused.
pub fn fetch_github_image(gh: &Gh, cwd: &Path, url: &str) -> Result<String> {
    let url = checked_image_url(url)?;
    fetch_with(&url, http_get, |url| raw_via_gh(gh, cwd, url))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    fn rejected(url: &str) -> bool {
        checked_image_url(url).is_err()
    }

    #[test]
    fn github_image_urls_are_accepted() {
        for url in [
            "https://github.com/user-attachments/assets/84ccda0a-5c4a-4fe4-b897-ed3f90e852b2",
            "https://github.com/fake/repo/assets/12/abc.png",
            "https://github.com/fake/repo/raw/main/docs/a.png",
            "https://user-images.githubusercontent.com/1/2-x.png",
            "https://private-user-images.githubusercontent.com/1/2-x.png?jwt=a.b.c",
            "https://raw.githubusercontent.com/fake/repo/main/a.png",
            "https://camo.githubusercontent.com/abc/def",
            "https://avatars.githubusercontent.com/u/1?v=4",
            "https://objects.githubusercontent.com/a",
            "https://media.githubusercontent.com/media/fake/repo/main/a.png",
            "https://release-assets.githubusercontent.com/a",
            "https://user-images.githubusercontent.com:443/1/2-x.png",
        ] {
            assert!(checked_image_url(url).is_ok(), "{url}");
        }
    }

    #[test]
    fn non_https_userinfo_ports_and_odd_characters_are_refused() {
        for url in [
            "http://user-images.githubusercontent.com/1/2-x.png",
            "file:///etc/passwd",
            "data:image/svg+xml,<svg/>",
            "javascript:alert(1)",
            "https://user:pw@user-images.githubusercontent.com/1/2-x.png",
            "https://user@user-images.githubusercontent.com/1/2-x.png",
            "https://user-images.githubusercontent.com:8443/1/2-x.png",
            " https://user-images.githubusercontent.com/1/2-x.png",
            "https://user-images.githubusercontent.com/1/2 x.png",
            "https://user-images.githubusercontent.com/1/2-x.png\n",
            "https://user-images.githubusercontent.com/1/\u{7f}.png",
            "",
            "not a url",
        ] {
            assert!(rejected(url), "{url}");
        }
        let long = format!(
            "https://user-images.githubusercontent.com/{}",
            "a".repeat(MAX_URL)
        );
        assert!(rejected(&long));
    }

    #[test]
    fn hosts_outside_the_github_image_allowlist_are_refused() {
        for url in [
            "https://localhost/a.png",
            "https://127.0.0.1/a.png",
            "https://[::1]/a.png",
            "https://169.254.169.254/latest/meta-data",
            "https://10.0.0.1/a.png",
            "https://evil.example/a.png",
            "https://github.com.evil.example/user-attachments/assets/x",
            "https://evil.githubusercontent.com.example/a.png",
            "https://githubusercontent.com/a.png",
            "https://gist.githubusercontent.com/a/b/raw/c.png",
            "https://api.github.com/repos/fake/repo",
            "https://github.com./user-attachments/assets/x",
            "https://img.shields.io/badge/a.svg",
        ] {
            assert!(rejected(url), "{url}");
        }
    }

    #[test]
    fn github_com_is_limited_to_attachment_and_repository_asset_paths() {
        for url in [
            "https://github.com/",
            "https://github.com/login",
            "https://github.com/settings/tokens",
            "https://github.com/fake/repo",
            "https://github.com/fake/repo/blob/main/a.png",
            "https://github.com/fake/repo/raw",
            "https://github.com/user-attachments",
            "https://github.com/fake/repo/raw/../../../settings",
        ] {
            assert!(rejected(url), "{url}");
        }
    }

    #[test]
    fn redirects_may_reach_github_hosts_and_its_asset_buckets_only() {
        for (url, ok) in [
            (
                "https://private-user-images.githubusercontent.com/1/2-x.png?jwt=1",
                true,
            ),
            (
                "https://github-production-user-asset-6210df.s3.amazonaws.com/1/x.png?X-Amz=1",
                true,
            ),
            (
                "https://objects.githubusercontent.com/github-production-release-asset/1",
                true,
            ),
            ("https://evil.s3.amazonaws.com/x.png", false),
            (
                "https://github-production-user-asset-6210df.s3.amazonaws.com.evil.example/x",
                false,
            ),
            (
                "http://github-production-user-asset-6210df.s3.amazonaws.com/x.png",
                false,
            ),
            ("https://127.0.0.1/x.png", false),
            ("https://localhost/x.png", false),
            ("https://evil.example/x.png", false),
            ("https://github.com/login?return_to=x", false),
            ("https://user:pw@objects.githubusercontent.com/x", false),
        ] {
            let parsed = url::Url::parse(url).unwrap();
            assert_eq!(allowed_hop(&parsed), ok, "{url}");
        }
    }

    #[test]
    fn only_raster_images_are_recognised_by_their_bytes() {
        let mut webp = b"RIFF\0\0\0\0WEBPVP8 ".to_vec();
        webp.extend([0; 8]);
        for (bytes, mime) in [
            (PNG.to_vec(), Some("image/png")),
            (b"\xff\xd8\xff\xe0\0\x10JFIF".to_vec(), Some("image/jpeg")),
            (b"GIF89a\x01\0\x01\0".to_vec(), Some("image/gif")),
            (b"GIF87a\x01\0\x01\0".to_vec(), Some("image/gif")),
            (webp, Some("image/webp")),
            (b"\0\0\0\x1cftypavif\0\0\0\0".to_vec(), Some("image/avif")),
            (b"\0\0\0\x1cftypavis\0\0\0\0".to_vec(), Some("image/avif")),
            (
                b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>".to_vec(),
                None,
            ),
            (b"<?xml version=\"1.0\"?><svg/>".to_vec(), None),
            (b"<!DOCTYPE html><html><script>x</script>".to_vec(), None),
            (b"\0\0\0\x1cftypisom\0\0\0\0".to_vec(), None),
            (b"RIFF\0\0\0\0WAVEfmt ".to_vec(), None),
            (Vec::new(), None),
        ] {
            assert_eq!(raster_mime(&bytes), mime, "{bytes:?}");
        }
        assert!(data_url(b"<svg/>").is_err());
        assert_eq!(
            data_url(b"GIF89a").unwrap(),
            "data:image/gif;base64,R0lGODlh"
        );
    }

    /// A reader that fails the test if anything reads it.
    struct Untouched;
    impl Read for Untouched {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            panic!("an oversized image was read")
        }
    }

    #[test]
    fn an_oversized_image_is_refused_before_it_is_read() {
        assert!(read_capped(Untouched, Some(MAX_IMAGE_BYTES + 1)).is_err());
        let big = std::io::repeat(0).take(MAX_IMAGE_BYTES + 10);
        assert!(
            read_capped(big, None).is_err(),
            "a missing length is still capped"
        );
        let lying = std::io::repeat(0).take(MAX_IMAGE_BYTES + 10);
        assert!(
            read_capped(lying, Some(10)).is_err(),
            "a lying length is still capped"
        );
        let exact = std::io::repeat(0).take(MAX_IMAGE_BYTES);
        assert_eq!(
            read_capped(exact, None).unwrap().len() as u64,
            MAX_IMAGE_BYTES
        );
    }

    #[test]
    fn a_missing_raw_image_is_read_through_gh_and_nothing_else_is() {
        let raw =
            url::Url::parse("https://raw.githubusercontent.com/fake/repo/main/a.png").unwrap();
        let png = fetch_with(&raw, |_| Ok(Response::NotFound), |_| Ok(PNG.to_vec())).unwrap();
        assert!(png.starts_with("data:image/png;base64,"), "{png}");

        let svg = fetch_with(&raw, |_| Ok(Response::NotFound), |_| Ok(b"<svg/>".to_vec()));
        assert!(svg.is_err());

        let other = url::Url::parse("https://user-images.githubusercontent.com/1/2-x.png").unwrap();
        let missing = fetch_with(&other, |_| Ok(Response::NotFound), |_| panic!("asked gh"));
        assert!(missing.is_err());
        let fetched = fetch_with(
            &other,
            |_| Ok(Response::Body(PNG.to_vec())),
            |_| panic!("asked gh"),
        );
        assert!(fetched.unwrap().starts_with("data:image/png;base64,"));
    }

    #[test]
    fn raw_images_map_to_the_contents_endpoint_of_their_repository() {
        for (url, endpoint) in [
            (
                "https://raw.githubusercontent.com/fake/repo/main/docs/a.png",
                Some("repos/fake/repo/contents/docs/a.png?ref=main"),
            ),
            (
                "https://raw.githubusercontent.com/fake/repo/refs/heads/dev/a%20b.png",
                Some("repos/fake/repo/contents/a%20b.png?ref=dev"),
            ),
            (
                "https://github.com/fake/repo/raw/v1.0/a.png",
                Some("repos/fake/repo/contents/a.png?ref=v1.0"),
            ),
            ("https://raw.githubusercontent.com/fake/repo/main", None),
            (
                "https://raw.githubusercontent.com/fake/repo/main/a.png?x=1",
                None,
            ),
            (
                "https://raw.githubusercontent.com/-fake/repo/main/a.png",
                None,
            ),
            (
                "https://raw.githubusercontent.com/fake/repo/ma&in/a.png",
                None,
            ),
            ("https://user-images.githubusercontent.com/1/2-x.png", None),
        ] {
            let parsed = url::Url::parse(url).unwrap();
            assert_eq!(raw_endpoint(&parsed).as_deref(), endpoint, "{url}");
        }
    }

    #[test]
    fn a_private_raw_image_comes_from_gh_with_its_output_bounded() {
        let bin = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let state = serde_json::json!({"auth": "ok", "raw_files": {
            "repos/fake/repo/contents/a.png?ref=main": "iVBORw0KGgoAAAANSUhEUg==",
            "repos/fake/repo/contents/big.png?ref=main": "big",
        }});
        crate::fake_gh::install(bin.path(), &state);
        let gh = Gh::default();
        gh.set_search_path(Some(vec![bin.path().to_path_buf()]));
        let raw = |path: &str| {
            let url = url::Url::parse(&format!(
                "https://raw.githubusercontent.com/fake/repo/main/{path}"
            ))
            .unwrap();
            raw_via_gh(&gh, cwd.path(), &url)
        };
        assert_eq!(raw("a.png").unwrap(), PNG);
        assert!(raw("big.png").is_err(), "more than the cap is refused");
        assert!(raw("missing.png").is_err());
    }
}
