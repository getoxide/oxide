import { ChevronDownIcon } from "@primer/octicons-react";
import { createContext, useCallback, useContext, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Popover } from "./Popover";

interface SplitButtonProps {
  /** What the main half shows; it runs `onClick`. */
  label: ReactNode;
  onClick: () => void;
  /** Disables the main half only: the menu may still hold something to do. */
  disabled?: boolean;
  /** Disables the chevron as well, e.g. when nothing in the menu applies. */
  menuDisabled?: boolean;
  /** An action is in flight: both halves wait and the main half keeps its colour. */
  pending?: boolean;
  /** Red-bordered, for an action that goes ahead despite a warning (failing checks). */
  risky?: boolean;
  /** The chevron's accessible name, also the menu's. */
  menuLabel: string;
  title?: string;
  width?: number;
  /** `SplitMenuItem`s, and any settings, shown in the attached menu. */
  children: ReactNode;
}

const CloseMenu = createContext<() => void>(() => {});

/** One blue button with an attached chevron: the main half runs the usual action, the menu runs
 *  an alternative with a single click. The menu is portalled and opens upward near the bottom. */
export function SplitButton(p: SplitButtonProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const closeAndFocus = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);
  const locked = p.pending === true;

  return (
    <div className={`split-btn${p.risky ? " risky" : ""}`} role="group">
      <button
        className={`primary split-btn-main${locked ? " pending" : ""}`}
        disabled={locked || p.disabled}
        title={p.title}
        onClick={() => {
          setOpen(false);
          p.onClick();
        }}
      >
        {p.label}
      </button>
      <button
        ref={trigger}
        className="primary split-btn-toggle"
        aria-label={p.menuLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        title={p.menuLabel}
        disabled={locked || p.menuDisabled}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronDownIcon size={16} />
      </button>
      {open && !locked && (
        <Popover anchor={trigger} label={p.menuLabel} onClose={close} width={p.width ?? 300}>
          <CloseMenu.Provider value={closeAndFocus}>
            <div className="split-menu">{p.children}</div>
          </CloseMenu.Provider>
        </Popover>
      )}
    </div>
  );
}

/** A group of actions in a split button's menu; the arrow keys move between them. */
export function SplitMenu({ label, children }: { label: string; children: ReactNode }) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')];
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "ArrowDown" ? (at + 1) % items.length
      : event.key === "ArrowUp" ? (at - 1 + items.length) % items.length
      : event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
      : null;
    if (next === null) return;
    event.preventDefault();
    items[next].focus();
  };
  return (
    <div role="menu" aria-label={label} className="split-menu-group" onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}

interface SplitMenuItemProps {
  title: ReactNode;
  help?: ReactNode;
  /** Marks the action the main half runs now. */
  checked?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/** One action in the menu: a click runs it and closes the menu. */
export function SplitMenuItem({ title, help, checked, disabled, onSelect }: SplitMenuItemProps) {
  const close = useContext(CloseMenu);
  return (
    <button
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked}
      className="split-menu-item"
      data-checked={checked}
      disabled={disabled}
      onClick={() => {
        close();
        onSelect();
      }}
    >
      <strong>{title}</strong>
      {help && <small>{help}</small>}
    </button>
  );
}
