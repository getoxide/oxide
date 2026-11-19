import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { runEditCommand } from "../terminal/editCommand";

const isMacPlatform = typeof navigator !== "undefined" && /Mac|iP(hone|od|ad)/i.test(navigator.userAgent || navigator.platform);
/** The hint for an operating-system edit key: ⌘C on macOS, Ctrl+C elsewhere. */
const formatAccelerator = (accelerator: string) =>
  accelerator.replace("Mod+", isMacPlatform ? "⌘" : "Ctrl+");

export interface ContextMenuActions {
  openProject: () => void;
  openSettings: () => void;
}

export interface Entry {
  label: string;
  hint?: string;
  run: () => void;
  disabled?: boolean;
}

interface Opening {
  x: number;
  y: number;
  selection: string;
  editable: boolean;
  /** Entries a component asked to show first, e.g. a Project row's actions. */
  extra: Entry[];
}

/** Lets a component put its own entries at the top of the right-click menu for that click. */
export function showContextMenu(event: { clientX: number; clientY: number }, entries: Entry[]) {
  window.dispatchEvent(new CustomEvent("oxide:context-menu", { detail: { x: event.clientX, y: event.clientY, entries } }));
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable;
}

/** Oxide's own right-click menu, replacing the webview's: edit commands where text is, app actions everywhere. */
export function ContextMenu({ actions }: { actions: ContextMenuActions }) {
  const [opening, setOpening] = useState<Opening | null>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = useCallback(() => { setOpening(null); setAt(null); }, []);

  useEffect(() => {
    let extra: Entry[] = [];
    const onEntries = (event: Event) => { extra = (event as CustomEvent<{ entries: Entry[] }>).detail.entries; };
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      setOpening({
        x: event.clientX,
        y: event.clientY,
        selection: window.getSelection()?.toString() ?? "",
        editable: isEditable(event.target),
        extra,
      });
      extra = [];
    };
    window.addEventListener("oxide:context-menu", onEntries);
    window.addEventListener("contextmenu", onContextMenu);
    return () => {
      window.removeEventListener("oxide:context-menu", onEntries);
      window.removeEventListener("contextmenu", onContextMenu);
    };
  }, []);

  useEffect(() => {
    if (!opening) return;
    const onPointer = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); return; }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
      if (items.length === 0) return;
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = (at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]!.focus();
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [opening, close]);

  // Keep the menu inside the window once its size is known.
  useLayoutEffect(() => {
    if (!opening || !menu.current) return;
    const { width, height } = menu.current.getBoundingClientRect();
    setAt({
      left: Math.max(4, Math.min(opening.x, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(opening.y, window.innerHeight - height - 4)),
    });
  }, [opening]);

  if (!opening) return null;

  const edit: Entry[] = opening.editable
    ? [
      { label: "Cut", hint: formatAccelerator("Mod+X"), run: () => runEditCommand("cut"), disabled: !opening.selection },
      { label: "Copy", hint: formatAccelerator("Mod+C"), run: () => runEditCommand("copy"), disabled: !opening.selection },
      { label: "Paste", hint: formatAccelerator("Mod+V"), run: () => runEditCommand("paste") },
      { label: "Select All", hint: formatAccelerator("Mod+A"), run: () => runEditCommand("selectAll") },
    ]
    : opening.selection
      ? [{ label: "Copy", hint: formatAccelerator("Mod+C"), run: () => runEditCommand("copy") }]
      : [];
  const app: Entry[] = opening.extra.length > 0 ? [] : [
    { label: "Open a Project…", run: actions.openProject },
    { label: "Settings", run: actions.openSettings },
  ];

  const renderGroup = (entries: Entry[]) => entries.map((entry) => (
    <button
      key={entry.label}
      type="button"
      role="menuitem"
      className="context-menu-item"
      disabled={entry.disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => { close(); entry.run(); }}
    >
      <span>{entry.label}</span>
      {entry.hint && <kbd>{entry.hint}</kbd>}
    </button>
  ));

  return (
    <div
      ref={menu}
      className="context-menu"
      role="menu"
      aria-label="Oxide"
      style={{ left: at?.left ?? opening.x, top: at?.top ?? opening.y, visibility: at ? "visible" : "hidden" }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {renderGroup(opening.extra)}
      {edit.length > 0 && <>{opening.extra.length > 0 && <div className="context-menu-sep" role="separator" />}{renderGroup(edit)}{app.length > 0 && <div className="context-menu-sep" role="separator" />}</>}
      {renderGroup(app)}
    </div>
  );
}
