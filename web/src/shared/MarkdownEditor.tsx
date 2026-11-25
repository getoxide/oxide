import {
  BoldIcon,
  CodeIcon,
  HeadingIcon,
  ItalicIcon,
  LinkIcon,
  ListOrderedIcon,
  ListUnorderedIcon,
  QuoteIcon,
  TasklistIcon,
} from "@primer/octicons-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type KeyboardEventHandler } from "react";
import { applyFormat, type Format } from "./markdownEdit";
import { filterMentions, mentionQuery } from "./mentions";
import { Markdown } from "../pull-requests/PullRequestMarkdown";

const TOOLS: { format: Format; label: string; Icon: typeof BoldIcon }[] = [
  { format: "heading", label: "Heading", Icon: HeadingIcon },
  { format: "bold", label: "Bold", Icon: BoldIcon },
  { format: "italic", label: "Italic", Icon: ItalicIcon },
  { format: "quote", label: "Quote", Icon: QuoteIcon },
  { format: "code", label: "Code", Icon: CodeIcon },
  { format: "link", label: "Link", Icon: LinkIcon },
  { format: "bullets", label: "Bulleted list", Icon: ListUnorderedIcon },
  { format: "numbers", label: "Numbered list", Icon: ListOrderedIcon },
  { format: "tasks", label: "Task list", Icon: TasklistIcon },
];

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  rows?: number;
  id?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
  /** Logins offered after `@`, most relevant first. No list without them. */
  mentions?: readonly string[];
  /** Called when the user starts typing a mention: the moment to fetch more candidates. */
  onMentionOpen?: () => void;
}

/** GitHub's comment box: Write and Preview tabs, and a toolbar that formats the selection. */
export function MarkdownEditor({
  value,
  onChange,
  label,
  placeholder,
  rows = 6,
  id,
  autoFocus,
  disabled,
  onKeyDown,
  mentions,
  onMentionOpen,
}: MarkdownEditorProps) {
  const [preview, setPreview] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  // The selection to restore once React has put the formatted text in the box.
  const selection = useRef<{ start: number; end: number } | null>(null);
  const listId = useId();
  const [caret, setCaret] = useState<number | null>(null);
  // The `@` whose list the user closed with Escape: it stays closed until another `@`.
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [pick, setPick] = useState({ key: "", index: 0 });
  const query = mentions && caret !== null && !preview && !disabled ? mentionQuery(value, caret) : null;
  const matches = query && query.start !== dismissed ? filterMentions(mentions ?? [], query.query) : [];
  const queryKey = query ? `${query.start}:${query.query}` : "";
  const active = pick.key === queryKey ? Math.min(pick.index, Math.max(matches.length - 1, 0)) : 0;
  const typingMention = query !== null;

  useEffect(() => {
    if (typingMention) onMentionOpen?.();
  }, [typingMention, onMentionOpen]);

  useLayoutEffect(() => {
    const el = area.current;
    const next = selection.current;
    if (!el || !next) return;
    selection.current = null;
    el.focus();
    el.setSelectionRange(next.start, next.end);
  }, [value]);

  function format(kind: Format) {
    const el = area.current;
    if (!el) return;
    const edit = applyFormat(el.value, el.selectionStart, el.selectionEnd, kind);
    selection.current = { start: edit.start, end: edit.end };
    onChange(edit.value);
  }

  function insertMention(login: string) {
    if (!query || caret === null) return;
    const text = `@${login} `;
    const at = query.start + text.length;
    selection.current = { start: at, end: at };
    setCaret(at);
    onChange(value.slice(0, query.start) + text + value.slice(caret));
  }

  function keyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (matches.length > 0 && !e.nativeEvent.isComposing) {
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setPick({ key: queryKey, index: (active + step + matches.length) % matches.length });
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && plain) {
        e.preventDefault();
        insertMention(matches[active]);
        return;
      }
      if (e.key === "Escape") {
        // Only the list closes: the form around the editor keeps its edit.
        e.preventDefault();
        e.stopPropagation();
        setDismissed(query?.start ?? null);
        return;
      }
    }
    onKeyDown?.(e);
  }

  return (
    <div className="md-editor" data-disabled={disabled || undefined}>
      <div className="md-editor-head">
        <div className="md-tabs" role="tablist" aria-label={`${label} mode`}>
          <button type="button" role="tab" aria-selected={!preview} onClick={() => setPreview(false)}>
            Write
          </button>
          <button type="button" role="tab" aria-selected={preview} onClick={() => setPreview(true)}>
            Preview
          </button>
        </div>
        {!preview && (
          <div className="md-tools" role="toolbar" aria-label="Formatting">
            {TOOLS.map(({ format: kind, label: name, Icon }) => (
              <button
                key={kind}
                type="button"
                className="md-tool"
                aria-label={name}
                title={name}
                disabled={disabled}
                // Keep the selection in the box while the button takes the click.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => format(kind)}
              >
                <Icon size={16} />
              </button>
            ))}
          </div>
        )}
      </div>
      {preview ? (
        <div className="md-preview">
          {value.trim() ? <Markdown source={value} /> : <p className="pr-field-empty">Nothing to preview</p>}
        </div>
      ) : (
        <textarea
          ref={area}
          id={id}
          aria-label={label}
          placeholder={placeholder}
          rows={rows}
          value={value}
          autoFocus={autoFocus}
          disabled={disabled}
          aria-autocomplete={mentions ? "list" : undefined}
          aria-controls={matches.length > 0 ? listId : undefined}
          aria-activedescendant={matches.length > 0 ? `${listId}-${active}` : undefined}
          onChange={(e) => {
            setCaret(e.target.selectionStart);
            onChange(e.target.value);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onBlur={() => setCaret(null)}
          onKeyDown={keyDown}
        />
      )}
      {matches.length > 0 && (
        <ul id={listId} className="md-mention-menu" role="listbox" aria-label="Mention someone">
          {matches.map((login, i) => (
            <li
              key={login}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              // Keep the caret in the box while the option takes the click.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insertMention(login)}
            >
              {login}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
