import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { runEditCommand } from "../terminal/editCommand";
import { currentPlatform } from "./platform";

/** The hint for an operating-system edit key: ⌘C on macOS, Ctrl+C elsewhere. */
export const formatAccelerator = (accelerator: string) =>
  accelerator.replace("Mod+", currentPlatform() === "macos" ? "⌘" : "Ctrl+");

export interface ContextMenuActions {
  openProject: () => void;
  newTerminal?: () => void;
  openSettings: () => void;
}

export interface Entry {
  label: string;
  hint?: string;
  run: () => void;
  disabled?: boolean;
  separatorBefore?: boolean;
}

export interface ShowContextMenuOptions {
  /** Omit generic Cut/Copy/Paste/Select All entries when the component provides its own. */
  replaceEdit?: boolean;
}

interface AttachedMenu {
  entries: Entry[];
  replaceEdit: boolean;
}

interface Opening {
  x: number;
  y: number;
  selection: string;
  editable: boolean;
  replaceEdit: boolean;
  /** Entries a component asked to show first, e.g. a Project row's actions. */
  extra: Entry[];
}

/** Entries components attached to one `contextmenu` event; keyed by the event, so they can never outlive it. */
const entriesByEvent = new WeakMap<Event, AttachedMenu>();

/** Lets a component put its own entries at the top of the right-click menu for that click. */
export function showContextMenu(
  event: Event | { nativeEvent: Event },
  entries: Entry[],
  options: ShowContextMenuOptions = {},
) {
  const native = "nativeEvent" in event ? event.nativeEvent : event;
  entriesByEvent.set(native, { entries, replaceEdit: options.replaceEdit ?? false });
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
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      // The Menu key or Shift+F10 reports no pointer position: open the menu under the focused element.
      const keyboard = event.clientX === 0 && event.clientY === 0 && event.target instanceof HTMLElement;
      const box = keyboard ? (event.target as HTMLElement).getBoundingClientRect() : null;
      const attached = entriesByEvent.get(event);
      setOpening({
        x: box ? box.left : event.clientX,
        y: box ? box.bottom : event.clientY,
        selection: window.getSelection()?.toString() ?? "",
        editable: isEditable(event.target),
        replaceEdit: attached?.replaceEdit ?? false,
        extra: attached?.entries ?? [],
      });
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
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

  const edit: Entry[] = opening.replaceEdit
    ? []
    : opening.editable
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
    ...(actions.newTerminal ? [{ label: "New terminal", run: actions.newTerminal }] : []),
    { label: "Settings", run: actions.openSettings },
  ];

  const renderGroup = (entries: Entry[]) => entries.map((entry, index) => (
    <Fragment key={entry.label}>
      {entry.separatorBefore && index > 0 && <div className="context-menu-sep" role="separator" />}
      <button
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
    </Fragment>
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
