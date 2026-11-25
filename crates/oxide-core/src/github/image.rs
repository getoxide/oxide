//! Images embedded in issue and pull request text: the signed URLs that make private
//! `user-attachments` readable without the user's token.

use serde::Serialize;

/// A `https://github.com/user-attachments/assets/<id>` URL and the short-lived signed URL
/// GitHub rendered for it, which loads without the user's token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedImage {
    pub url: String,
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
        let url = format!("https://github.com/user-attachments/assets/{id}");
        if out.iter().all(|image| image.url != url) {
            out.push(SignedImage {
                url,
                signed_url: src,
            });
        }
    }
}
