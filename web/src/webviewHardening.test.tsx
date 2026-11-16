import { ESLint } from "eslint";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AttachmentChip } from "./AttachmentChip";
import { ChatMarkdown } from "./ChatMarkdown";
import { ItemContent } from "./ItemContent";
import { createHighlightService } from "./highlightService";
import tauriConf from "../../crates/oxide-app/tauri.conf.json?raw";
import capabilityFile from "../../crates/oxide-app/capabilities/default.json?raw";
import itemContentSource from "./ItemContent.tsx?raw";
import composerInputSource from "./ComposerInput.tsx?raw";

// What the highlighter hands the code block: undefined until highlighted, then Shiki's HTML.
const highlighted = vi.hoisted(() => ({ html: undefined as string | undefined }));
vi.mock("./highlighter", () => ({
  highlighter: () => ({
    cached: () => highlighted.html,
    highlight: () => new Promise<string>(() => {}),
  }),
}));

const HOSTILE = "</code><img src=x onerror=alert(1)>";
const conf = JSON.parse(tauriConf);
const capability = JSON.parse(capabilityFile);
const webRoot = new URL("..", import.meta.url).pathname;

describe("hostile text renders as literal text", () => {
  it("in a code fence", () => {
    vi.stubGlobal("Worker", class { postMessage() {} onmessage = null; });
    const html = renderToStaticMarkup(<ItemContent content={"```html\n" + HOSTILE + "\n```"} />);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("in a highlighted code fence, which reaches the HTML sink", async () => {
    // The real highlight service, as the worker runs it, on hostile source.
    highlighted.html = await createHighlightService().highlight(HOSTILE, "html");
    try {
      expect(highlighted.html).toContain("shiki");
      const html = renderToStaticMarkup(<ItemContent content={"```html\n" + HOSTILE + "\n```"} />);
      // The sink ran (Shiki's markup is there) and the source is still inert text.
      expect(html).toContain('class="shiki');
      expect(html).not.toContain("<img");
      expect(html).toContain("&#x3C;"); // Shiki escapes every `<` of the source
    } finally {
      highlighted.html = undefined;
    }
  });

  it("in inline Markdown", () => {
    const html = renderToStaticMarkup(<ChatMarkdown text={"`" + HOSTILE + "` and " + HOSTILE} />);
    expect(html).not.toContain("<img");
  });

  it("in an Attachment name", () => {
    const html = renderToStaticMarkup(
      <AttachmentChip name={'"><img src=x onerror=alert(1)>.png'} kind="image" sizeBytes={10} removable />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("Tauri security configuration", () => {
  const csp: string = conf.app.security.csp;

  it("ships the strict production CSP without a dev server origin", () => {
    expect(csp).toBe(
      "default-src 'self'; script-src 'self'; worker-src 'self' blob:; connect-src ipc: http://ipc.localhost; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://github.com https://avatars.githubusercontent.com; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(csp).not.toMatch(/localhost:1420|ws:/);
  });

  it("keeps the dev server origin in the dev-only CSP", () => {
    expect(conf.app.security.devCsp).toContain("ws://localhost:1420");
    expect(conf.app.security.devCsp).toContain("http://localhost:1420");
  });

  it("does not freeze the prototype (Monaco and the terminal assign toString on plain objects)", () => {
    expect(conf.app.security.freezePrototype).not.toBe(true);
  });

  it("describes the capability truthfully and points to ADR-0016", () => {
    expect(capability.description).toMatch(/ADR-0016/);
    expect(capability.description).toMatch(/start processes/i);
  });
});

describe("HTML sink lint rule", () => {
  const sinkMessages = async (code: string, filePath: string) => {
    const [r] = await new ESLint({ cwd: webRoot }).lintText(code, { filePath });
    return r.messages.filter((m) => m.ruleId?.startsWith("no-restricted"));
  };

  it("rejects each HTML sink in a new file", async () => {
    const file = webRoot + "src/sinkProbe.tsx";
    for (const code of [
      "export const a = <div dangerouslySetInnerHTML={{ __html: 'x' }} />;",
      "document.body.innerHTML = 'x';",
      "document.body.outerHTML = 'x';",
      "document.body.insertAdjacentHTML('beforeend', 'x');",
    ]) {
      expect((await sinkMessages(code, file)).length, code).toBeGreaterThan(0);
    }
  });

  it("allows the two documented sinks", async () => {
    for (const [f, source] of [["ItemContent.tsx", itemContentSource], ["ComposerInput.tsx", composerInputSource]]) {
      expect(await sinkMessages(source, webRoot + "src/" + f)).toEqual([]);
    }
  });
});
