import { useEffect, useRef, useState } from "react";
import { TerminalIcon, XIcon } from "@primer/octicons-react";
import { showContextMenu } from "../shared/ContextMenu";

interface Props {
  name: string;
  current: boolean;
  /** The command the Terminal runs, or `null` when its shell is idle. */
  running: string | null;
  onSelect: () => void;
  onRename: (name: string) => void;
  onClose: () => void;
}

/**
 * One Terminal in the sidebar. Its name is renamed in place, like a file in the Finder: a double
 * click, a Force Click on a Mac trackpad, or Rename on its menu turn the title into a field with
 * the name selected. Enter or leaving the field keeps the name, Escape restores it.
 */
export function TerminalRow({ name, current, running, onSelect, onRename, onClose }: Props) {
  const [editing, setEditing] = useState(false);
  const item = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  // Leaving with Escape must not let the blur that follows commit the draft.
  const cancelled = useRef(false);

  useEffect(() => {
    const element = item.current;
    if (!element) return;
    // WebKit's Force Click: keep the system's Look Up panel away and rename instead.
    const before = (event: Event) => event.preventDefault();
    const force = (event: Event) => {
      event.preventDefault();
      setEditing(true);
    };
    element.addEventListener("webkitmouseforcewillbegin", before);
    element.addEventListener("webkitmouseforcedown", force);
    return () => {
      element.removeEventListener("webkitmouseforcewillbegin", before);
      element.removeEventListener("webkitmouseforcedown", force);
    };
  }, [editing]);

  useEffect(() => {
    if (!editing) return;
    cancelled.current = false;
    field.current?.focus();
    field.current?.select();
  }, [editing]);

  const finish = (commit: boolean) => {
    const value = field.current?.value ?? name;
    setEditing(false);
    if (commit) onRename(value);
    requestAnimationFrame(() => item.current?.focus());
  };

  return (
    <li className={`terminal-row${editing ? " renaming" : ""}`}
      onContextMenu={(event) => showContextMenu(event, [
        { label: "Rename", run: () => setEditing(true) },
        { label: "Close terminal", run: onClose },
      ])}>
      {editing ? (
        <div className="terminal-item terminal-item-editing">
          <TerminalIcon size={12} />
          <input
            ref={field}
            className="terminal-rename-input"
            defaultValue={name}
            spellCheck={false}
            autoComplete="off"
            aria-label={`Rename ${name}`}
            onBlur={() => { if (!cancelled.current) finish(true); }}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); finish(true); }
              if (event.key === "Escape") { event.preventDefault(); cancelled.current = true; finish(false); }
            }}
          />
        </div>
      ) : (
        <>
          <button
            ref={item}
            className="terminal-item"
            aria-current={current}
            title={`${name}${running ? ` — running ${running}` : ""}. Double-click or Force Click to rename.`}
            onClick={onSelect}
            onDoubleClick={(event) => {
              event.preventDefault();
              setEditing(true);
            }}
          >
            <TerminalIcon size={12} />
            <span className="terminal-item-title">{name}</span>
            {running && <span className="terminal-tab-running" aria-label="Command running" />}
          </button>
          <button className="row-action" onClick={onClose} aria-label={`Close ${name}`} title="Close terminal">
            <XIcon size={12} />
          </button>
        </>
      )}
    </li>
  );
}
