import {
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { CheckIcon, SyncIcon } from "@primer/octicons-react";
import { commands, type LanguageTool } from "../bindings";
import { Popover } from "../shared/Popover";
import { monaco } from "./editorRuntime";
import { InstallLanguageButton } from "./LanguageSupport";

type ServerStatus = "Ready" | "Connecting" | "Not installed" | "Stopped";

/** Reads a language server's reported state (Ready, Connecting…, or an error message) as one of four. */
function serverStatus(state: string | undefined): ServerStatus {
  if (state === "Ready") return "Ready";
  if (state === undefined || state.startsWith("Connecting")) return "Connecting";
  if (state.startsWith("Not installed")) return "Not installed";
  return "Stopped";
}

/** The status bar's short form of a language server's state. */
export function serverStatusLabel(state: string | undefined): string {
  return `LSP ${serverStatus(state).toLowerCase()}`;
}

interface LanguageMode {
  id: string;
  label: string;
}

/** The language modes the editor runtime knows, Plain text included, by name. */
function languageModes(): LanguageMode[] {
  const modes = new Map<string, LanguageMode>([
    ["plaintext", { id: "plaintext", label: "Plain Text" }],
  ]);
  for (const language of monaco.languages.getLanguages())
    modes.set(language.id, {
      id: language.id,
      label: language.aliases?.[0] ?? language.id,
    });
  return [...modes.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** The name a language mode is shown by. */
export function languageLabel(id: string): string {
  return languageModes().find((mode) => mode.id === id)?.label ?? id;
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
  state: string | undefined;
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
    : serverStatus(state?.startsWith("Not installed") ? undefined : state);
  return (
    <section className="language-server" aria-label="Language server">
      <header>
        <strong className="grow">{tool.name}</strong>
        <span className={`language-server-state ${status.toLowerCase().replace(" ", "-")}`}>
          {status}
        </span>
      </header>
      {status === "Stopped" && state && <p className="dim">{state}</p>}
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
  serverState: string | undefined;
  onSelect: (languageId: string) => void;
  onRestart: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const modes = useMemo(languageModes, []);
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
