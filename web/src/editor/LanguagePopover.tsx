import {
  useEffect,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { CheckIcon, SyncIcon } from "@primer/octicons-react";
import { commands, type LanguageTool } from "../bindings";
import { Popover } from "../shared/Popover";
import { monaco } from "./editorRuntime";
import { InstallLanguageButton } from "./LanguageSupport";
import type { LanguageServerState } from "./editorLanguages";

/** The status bar's short form of a language server's state; one not reported yet is coming up. */
export function serverStatusLabel(state: LanguageServerState | undefined): string {
  return `LSP ${(state?.status ?? "Connecting").toLowerCase()}`;
}

interface LanguageMode {
  id: string;
  label: string;
}

const PLAIN_TEXT: LanguageMode = { id: "plaintext", label: "Plain text" };
let catalog: { modes: LanguageMode[]; labels: Map<string, string> } | null = null;

/** The language modes the editor runtime knows, Plain text included, by name. Built once: Oxide registers its languages before any editor opens. */
function languageCatalog() {
  if (!catalog) {
    const labels = new Map<string, string>();
    for (const language of monaco.languages.getLanguages())
      labels.set(language.id, language.aliases?.[0] ?? language.id);
    labels.set(PLAIN_TEXT.id, PLAIN_TEXT.label);
    const modes = [...labels]
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
    catalog = { modes, labels };
  }
  return catalog;
}

/** The name a language mode is shown by. */
export function languageLabel(id: string): string {
  return languageCatalog().labels.get(id) ?? id;
}

/** Arrow keys move between the options of the list, and from the filter into it. */
function moveFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const options = [
    ...(event.currentTarget
      .closest(".language-popover")
      ?.querySelectorAll<HTMLElement>('[role="option"]') ?? []),
  ];
  if (options.length === 0) return;
  event.preventDefault();
  const at = options.indexOf(document.activeElement as HTMLElement);
  const next =
    event.key === "ArrowDown"
      ? Math.min(options.length - 1, at + 1)
      : Math.max(0, at - 1);
  options[next].focus();
}

/** A managed language server: its live state, Install / Reinstall support and Restart. */
function LanguageServer({
  language,
  state,
  onRestart,
}: {
  language: string;
  state: LanguageServerState | undefined;
  onRestart: () => void;
}) {
  const [tool, setTool] = useState<LanguageTool | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void commands
        .languageTools()
        .then((tools) => {
          if (active) setTool(tools.find((t) => t.language === language) ?? null);
        })
        .catch(() => {});
    };
    refresh();
    window.addEventListener("oxide-language-tools-changed", refresh);
    return () => {
      active = false;
      window.removeEventListener("oxide-language-tools-changed", refresh);
    };
  }, [language]);
  if (!tool) return null;
  // A server that is installed by now is coming up, whatever it said before the install.
  const status = !tool.installed
    ? "Not installed"
    : !state || state.status === "Not installed"
      ? "Connecting"
      : state.status;
  return (
    <section className="language-server" aria-label="Language server">
      <header>
        <strong className="grow">{tool.name}</strong>
        <span className={`language-server-state ${status.toLowerCase().replace(" ", "-")}`}>
          {status}
        </span>
      </header>
      {status === "Stopped" && state && <p className="dim">{state.message}</p>}
      <div className="language-server-actions">
        <InstallLanguageButton
          tool={tool}
          onInstalled={() => setTool({ ...tool, installed: true })}
        />
        {tool.installed && (
          <button className="btn" onClick={onRestart}>
            <SyncIcon size={14} /> Restart server
          </button>
        )}
      </div>
    </section>
  );
}

/** The status bar's language control: the buffer's language mode and its language server. */
export function LanguagePopover({
  anchor,
  languageId,
  server,
  serverState,
  onSelect,
  onRestart,
  onClose,
}: {
  anchor: RefObject<HTMLElement | null>;
  languageId: string;
  /** The managed language server of the mode, if it has one. */
  server: string | null;
  serverState: LanguageServerState | undefined;
  onSelect: (languageId: string) => void;
  onRestart: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const { modes } = languageCatalog();
  const shown = modes.filter((mode) =>
    `${mode.label} ${mode.id}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <Popover anchor={anchor} label="Language" onClose={onClose}>
      <div className="language-popover">
        {server && (
          <LanguageServer
            key={server}
            language={server}
            state={serverState}
            onRestart={onRestart}
          />
        )}
        <section className="language-modes" aria-label="Language mode">
          <input
            aria-label="Filter languages"
            placeholder="Select language mode…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={moveFocus}
          />
          <div role="listbox" aria-label="Language modes" onKeyDown={moveFocus}>
            {shown.map((mode) => (
              <button
                key={mode.id}
                role="option"
                aria-selected={mode.id === languageId}
                onClick={() => onSelect(mode.id)}
              >
                <span className="grow">{mode.label}</span>
                {mode.id === languageId && <CheckIcon size={14} />}
              </button>
            ))}
            {shown.length === 0 && <p className="dim">No matching languages.</p>}
          </div>
        </section>
      </div>
    </Popover>
  );
}
