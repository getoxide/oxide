import { useMemo, useState, type KeyboardEvent } from "react";
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  SHORTCUT_CATEGORIES,
  eventToShortcut,
  findDuplicateShortcuts,
  formatShortcut,
  isTerminalConflict,
  loadShortcutOverrides,
  resolveShortcuts,
  saveShortcutOverrides,
  type ShortcutAction,
  type ShortcutActionId,
  type ShortcutOverrides,
} from "../shared/shortcuts";

const ACTION_BY_ID = new Map<ShortcutActionId, ShortcutAction>(
  SHORTCUT_ACTIONS.map((action) => [action.id, action]),
);

/** Grouped, searchable shortcut editor with recording mode and conflict warnings. */
export function ShortcutsSettings() {
  const [overrides, setOverrides] = useState<ShortcutOverrides>(loadShortcutOverrides);
  const [query, setQuery] = useState("");
  const [recordingId, setRecordingId] = useState<ShortcutActionId | null>(null);

  const resolved = useMemo(() => resolveShortcuts(overrides), [overrides]);
  const duplicates = useMemo(() => findDuplicateShortcuts(resolved), [resolved]);

  const updateOverrides = (next: ShortcutOverrides) => {
    saveShortcutOverrides(next);
    setOverrides(loadShortcutOverrides());
  };

  const setBinding = (id: ShortcutActionId, binding: string) => {
    const next: ShortcutOverrides = { ...overrides };
    if (binding === DEFAULT_SHORTCUTS[id]) delete next[id];
    else next[id] = binding;
    updateOverrides(next);
  };

  const normalizedQuery = query.trim().toLowerCase();
  const filteredActions = useMemo(() => {
    if (!normalizedQuery) return SHORTCUT_ACTIONS;
    return SHORTCUT_ACTIONS.filter((action) => {
      const formatted = formatShortcut(resolved[action.id]).toLowerCase();
      return (
        action.label.toLowerCase().includes(normalizedQuery) ||
        action.category.toLowerCase().includes(normalizedQuery) ||
        formatted.includes(normalizedQuery)
      );
    });
  }, [normalizedQuery, resolved]);

  const handleRecordKeyDown = (event: KeyboardEvent<HTMLButtonElement>, action: ShortcutAction) => {
    if (recordingId !== action.id) return;
    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      setRecordingId(null);
      return;
    }
    if ((event.key === "Backspace" || event.key === "Delete") && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      setBinding(action.id, "");
      setRecordingId(null);
      return;
    }
    const combo = eventToShortcut(event.nativeEvent);
    if (!combo) return;
    setBinding(action.id, combo);
    setRecordingId(null);
  };

  const hasCustomizations = Object.keys(overrides).length > 0;

  return (
    <div className="shortcuts-settings">
      <div className="shortcuts-toolbar">
        <input
          type="search"
          className="shortcuts-search"
          aria-label="Search shortcuts"
          placeholder="Search shortcuts…"
          value={query}
          onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          className="btn sm"
          aria-label="Reset all shortcuts"
          disabled={!hasCustomizations}
          onClick={() => {
            setRecordingId(null);
            updateOverrides({});
          }}
        >
          Reset all shortcuts
        </button>
      </div>

      {SHORTCUT_CATEGORIES.map((category) => {
        const actions = filteredActions.filter((action) => action.category === category);
        if (actions.length === 0) return null;
        return (
          <div key={category} className="shortcuts-group">
            <h3 className="shortcuts-group-title">{category}</h3>
            <div className="settings-card">
              {actions.map((action) => {
                const binding = resolved[action.id];
                const isRecording = recordingId === action.id;
                const isCustom = binding !== action.defaultShortcut;
                const dupeIds = duplicates[action.id] ?? [];
                const terminalConflict =
                  binding !== "" &&
                  isTerminalConflict(binding) &&
                  (isCustom || action.scope !== "code");
                const formatted = formatShortcut(binding);

                return (
                  <div key={action.id} className="settings-item shortcut-row">
                    <div className="settings-item-label">
                      <strong>{action.label}</strong>
                      {(dupeIds.length > 0 || terminalConflict) && (
                        <span className="shortcut-warnings" role="status">
                          {dupeIds.length > 0 && (
                            <span className="shortcut-warning">
                              Also assigned to{" "}
                              {dupeIds
                                .map((id) => ACTION_BY_ID.get(id)?.label ?? id)
                                .join(", ")}
                            </span>
                          )}
                          {terminalConflict && (
                            <span className="shortcut-warning">
                              Conflicts with Terminal control key
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                    <div className="settings-item-controls shortcut-controls">
                      <button
                        type="button"
                        className={`shortcut-key-btn${isRecording ? " recording" : ""}${!formatted ? " unassigned" : ""}`}
                        aria-label={`Shortcut for ${action.label}`}
                        aria-pressed={isRecording}
                        data-shortcut-recording={isRecording ? "true" : undefined}
                        onClick={() => setRecordingId(isRecording ? null : action.id)}
                        onBlur={() => {
                          if (isRecording) setRecordingId(null);
                        }}
                        onKeyDown={(event) => handleRecordKeyDown(event, action)}
                      >
                        {isRecording ? "Press keys…" : formatted || "Unassigned"}
                      </button>
                      {isCustom && (
                        <button
                          type="button"
                          className="btn sm"
                          aria-label={`Reset ${action.label}`}
                          onClick={() => {
                            setRecordingId(null);
                            setBinding(action.id, action.defaultShortcut);
                          }}
                        >
                          Reset
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {filteredActions.length === 0 && (
        <p className="settings-note">No shortcuts match &ldquo;{query}&rdquo;.</p>
      )}
    </div>
  );
}
