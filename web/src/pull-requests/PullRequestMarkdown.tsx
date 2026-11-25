import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SignedImage } from "../bindings";
import { openExternalLink } from "../shared/externalLink";
import { cachedGithubImage, githubAssetId, isGithubImageUrl, loadGithubImage } from "../shared/githubImages";
import { limitBlocks, parseMarkdown, type Inline } from "./prMarkdown";

const ImagesContext = createContext<{ projectId: number; signed: Map<string, string> } | null>(null);

/** Lets the Markdown inside load GitHub images through the Project, using the signed URLs GitHub
 *  gave for private attachments. Without it, every image is shown as a link. */
export function MarkdownImages({ projectId, signed, children }: { projectId: number; signed: SignedImage[]; children: ReactNode }) {
  const value = useMemo(() => ({ projectId, signed: new Map(signed.map((s) => [s.assetId, s.signedUrl])) }), [projectId, signed]);
  return <ImagesContext.Provider value={value}>{children}</ImagesContext.Provider>;
}

/** `children` able to load GitHub images: under the detail view's `MarkdownImages` when there is
 *  one (with its signed URLs), else through `projectId` alone when it is given. */
export function MarkdownImagesFallback({ projectId, children }: { projectId?: number; children: ReactNode }) {
  const images = useContext(ImagesContext);
  if (images || projectId === undefined) return <>{children}</>;
  return (
    <MarkdownImages projectId={projectId} signed={NO_SIGNED}>
      {children}
    </MarkdownImages>
  );
}

const NO_SIGNED: SignedImage[] = [];

/** An image, loaded once it scrolls near view; its alt text and an "Open image" link when it is
 *  not on GitHub or cannot be loaded. */
function MarkdownImage({ alt, url }: { alt: string; url: string }) {
  const images = useContext(ImagesContext);
  const projectId = images?.projectId;
  const asset = githubAssetId(url);
  const source = (asset && images?.signed.get(asset)) || url;
  const loadable = projectId !== undefined && isGithubImageUrl(url);
  const [src, setSrc] = useState(() => cachedGithubImage(url));
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!loadable || src || projectId === undefined) return;
    let cancelled = false;
    // Leaving before its turn gives the slot to an image still on screen.
    const gone = new AbortController();
    const start = () =>
      void loadGithubImage(projectId, url, source, gone.signal).then(
        (data) => !cancelled && setSrc(data),
        () => !cancelled && setFailed(true),
      );
    const element = ref.current;
    if (typeof IntersectionObserver === "undefined" || !element) {
      start();
      return () => {
        cancelled = true;
        gone.abort();
      };
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        start();
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => {
      cancelled = true;
      gone.abort();
      observer.disconnect();
    };
  }, [loadable, src, projectId, url, source]);
  if (loadable && src) return <img className="md-image" src={src} alt={alt} />;
  if (loadable && !failed) {
    return <span ref={ref} className="md-image-loading" role="img" aria-label={alt ? `Loading ${alt}` : "Loading image"} />;
  }
  return (
    <span className="md-image-fallback">
      <span>{alt || "Image"}</span>
      <button type="button" className="md-image-open" title={url} onClick={() => void openExternalLink(url)}>
        Open image
      </button>
    </span>
  );
}

function inline(parts: Inline[]): ReactNode[] {
  return parts.map((p, i) => {
    if (p.kind === "image") return <MarkdownImage key={`${i}:${p.url}`} alt={p.alt} url={p.url} />;
    if (p.kind === "code") return <code key={i}>{p.text}</code>;
    if (p.kind === "strong") return <strong key={i}>{p.text}</strong>;
    if (p.kind === "link") return <span key={i} className="md-link">{p.text}</span>;
    if (p.kind === "mention") {
      return (
        <button
          key={i}
          type="button"
          className="md-mention"
          title={`Open ${p.login} on GitHub`}
          onClick={() => void openExternalLink(`https://github.com/${p.login}`)}
        >
          {p.text}
        </button>
      );
    }
    return p.text;
  });
}

/** A pull request description or comment, read for the narrow panel. */
export function Markdown({ source, maxLines }: { source: string; maxLines?: number }) {
  const blocks = useMemo(() => {
    const all = parseMarkdown(source);
    return maxLines === undefined ? all : limitBlocks(all, maxLines).blocks;
  }, [source, maxLines]);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "heading":
            return <p key={i} className={`md-h md-h${Math.min(b.level, 3)}`}>{inline(b.inline)}</p>;
          case "paragraph":
            return <p key={i}>{inline(b.inline)}</p>;
          case "code":
            return <pre key={i}>{b.text}</pre>;
          case "rule":
            return <hr key={i} />;
          case "table":
            return (
              <div key={i} className="md-table">
                <table>
                  <thead>
                    <tr>{b.header.map((cell, j) => <th key={j}>{inline(cell)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, j) => (
                      <tr key={j}>{row.map((cell, k) => <td key={k}>{inline(cell)}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "list":
            return (
              <ul key={i}>
                {b.items.map((item, j) => (
                  <li key={j} className={item.checked === null ? undefined : "md-task"}>
                    {item.checked !== null && (
                      <span className={`md-box${item.checked ? " done" : ""}`} role="img" aria-label={item.checked ? "Done" : "Not done"} />
                    )}
                    <span>{inline(item.inline)}</span>
                  </li>
                ))}
              </ul>
            );
        }
      })}
    </div>
  );
}
