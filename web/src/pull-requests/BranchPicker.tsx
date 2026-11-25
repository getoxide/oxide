import { useId, useRef, useState, type KeyboardEvent } from "react";
import { CheckIcon, ChevronDownIcon, GitBranchIcon } from "@primer/octicons-react";
import { Popover } from "../shared/Popover";

/** Above this many branches the list gets a filter field. */
const FILTER_FROM = 8;

/** A quiet button showing a branch, opening a filterable list to choose another one. */
export function BranchPicker({
  label,
  value,
  branches,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  branches: string[];
  disabled?: boolean;
  onChange: (branch: string) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="branch-picker"
        aria-label={`${label}: ${value}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={value}
        disabled={disabled}
        onClick={() => setOpen((was) => !was)}
      >
        <GitBranchIcon size={14} className="branch-picker-icon" />
        <span className="branch-picker-name">{value}</span>
        <ChevronDownIcon size={12} className="branch-picker-chevron" />
      </button>
      {open && (
        <Popover anchor={trigger} label={label} width={300} onClose={() => setOpen(false)}>
          <BranchList
            label={label}
            value={value}
            branches={branches}
            onChoose={(branch) => {
              setOpen(false);
              trigger.current?.focus();
              if (branch !== value) onChange(branch);
            }}
          />
        </Popover>
      )}
    </>
  );
}

function BranchList({
  label,
  value,
  branches,
  onChoose,
}: {
  label: string;
  value: string;
  branches: string[];
  onChoose: (branch: string) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = branches.filter((b) => b.toLowerCase().includes(q));
  const [active, setActive] = useState(() => Math.max(0, shown.indexOf(value)));
  const at = Math.min(active, shown.length - 1);
  const filtered = branches.length > FILTER_FROM;

  function onKeyDown(event: KeyboardEvent) {
    const last = shown.length - 1;
    const next =
      event.key === "ArrowDown" ? Math.min(at + 1, last)
      : event.key === "ArrowUp" ? Math.max(at - 1, 0)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null;
    if (next !== null) {
      event.preventDefault();
      setActive(next);
      document.getElementById(`${id}-${next}`)?.scrollIntoView?.({ block: "nearest" });
    } else if (event.key === "Enter" && at >= 0) {
      event.preventDefault();
      onChoose(shown[at]);
    }
  }

  return (
    <div className="branch-list" onKeyDown={onKeyDown}>
      {filtered && (
        <input
          aria-label="Filter branches"
          placeholder="Filter branches"
          value={query}
          aria-controls={`${id}-list`}
          aria-activedescendant={at >= 0 ? `${id}-${at}` : undefined}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
        />
      )}
      <ul
        id={`${id}-list`}
        role="listbox"
        aria-label={label}
        tabIndex={filtered ? -1 : 0}
        aria-activedescendant={!filtered && at >= 0 ? `${id}-${at}` : undefined}
      >
        {shown.map((branch, i) => (
          <li
            key={branch}
            id={`${id}-${i}`}
            role="option"
            aria-selected={branch === value}
            className={i === at ? "active" : undefined}
            title={branch}
            onPointerMove={() => setActive(i)}
            onClick={() => onChoose(branch)}
          >
            <span className="branch-list-check" aria-hidden>
              {branch === value && <CheckIcon size={14} />}
            </span>
            <span className="branch-list-name">{branch}</span>
          </li>
        ))}
      </ul>
      {shown.length === 0 && <p className="branch-list-empty">No branch matches.</p>}
    </div>
  );
}
