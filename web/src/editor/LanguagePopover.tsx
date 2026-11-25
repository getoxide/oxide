import { useMemo, useState, type KeyboardEvent, type RefObject } from "react";
import { CheckIcon } from "@primer/octicons-react";
import { Popover } from "../shared/Popover";
import { monaco } from "./editorRuntime";

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

/** The status bar's language control: the buffer's language mode and its language server. */
export function LanguagePopover({
  anchor,
  languageId,
  onSelect,
  onClose,
}: {
  anchor: RefObject<HTMLElement | null>;
  languageId: string;
  onSelect: (languageId: string) => void;
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
