import { Skeleton } from "./Skeleton";
import { useEffect, useState } from "react";
import { CUSTOM_AGENT_LIMITS, customAgentName, customProviderId, isCustomProvider } from "./customAgents";
import {
  commands,
  type PermissionMode,
  type Settings,
  type Thread,
} from "./bindings";
import {
  defaultDispatchForm,
  dispatchRequest,
  issueDispatchForm,
  startsAsTerminal,
  terminalIssue,
  withProvider,
  type DispatchForm,
  type DispatchIssue,
} from "./dispatch";

const PROVIDERS = [
  { id: "claude", name: "Claude" },
  { id: "codex", name: "Codex" },
  { id: "antigravity", name: "Antigravity" },
];

const PERMISSION_MODES: { id: PermissionMode; name: string }[] = [
  { id: "ask", name: "Ask" },
  { id: "auto-edit", name: "Auto-edit" },
  { id: "full-access", name: "Full access" },
];

interface DispatchDialogProps {
  projectId: number;
  /** The issue the task starts from: it prefills the prompt, and the Thread is linked to it. */
  issue?: DispatchIssue;
  onClose: () => void;
  onDispatched: (thread: Thread) => void;
}

/** Hands a task off to a new background Thread in a worktree of its own. */
export function DispatchDialog({
  projectId,
  issue,
  onClose,
  onDispatched,
}: DispatchDialogProps) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [form, setForm] = useState<DispatchForm | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A Custom agent's Thread was created; its first prompt waits for the user to ask for it. */
  const [pasting, setPasting] = useState<{ thread: Thread; prompt: string } | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([
      commands.getSettings(),
      commands.gitStatus(projectId, null),
      commands.listBranches(projectId, null),
    ]).then(([state, status, list]) => {
      if (!active) return;
      const current = status.status === "ok" ? status.data.branch : null;
      setSettings(state.settings);
      const form = defaultDispatchForm(state.settings, current);
      setForm(issue ? issueDispatchForm(form, issue) : form);
      if (list.status === "ok")
        setBranches(list.data.filter((b) => !b.remote).map((b) => b.name));
      if (status.status === "error") setError(status.error.message);
    });
    return () => {
      active = false;
    };
  }, [projectId, issue]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const dispatch = async () => {
    if (!form || busy) return;
    setBusy(true);
    setError(null);
    if (settings && issue && isCustomProvider(form.provider)) {
      // Oxide does not know how a Custom agent takes a prompt: start it bare, then show the
      // prompt for the user to confirm and paste (never submitted).
      const created = await commands.createTerminalThreadFromIssue(
        projectId,
        terminalIssue(issue),
        form.provider,
        null,
        null,
        null,
      );
      if (created.status === "error") {
        setBusy(false);
        setError(created.error.message);
        return;
      }
      const prompt = await commands.terminalIssuePrompt(terminalIssue(issue));
      setBusy(false);
      setPasting({ thread: created.data, prompt });
      return;
    }
    const res =
      settings && startsAsTerminal(settings, form.provider, issue)
        ? await commands.createTerminalThreadFromIssue(
            projectId,
            terminalIssue(issue!),
            form.provider,
            form.model.trim() || null,
            form.effort.trim() || null,
            form.permissionMode,
          )
        : await commands.dispatchThread(
            dispatchRequest(projectId, form, issue),
          );
    setBusy(false);
    if (res.status === "ok") onDispatched(res.data);
    else setError(res.error.message);
  };

  const paste = async () => {
    if (!pasting || busy) return;
    setBusy(true);
    setError(null);
    const sent = await commands.deliverAgentPrompt(pasting.thread.id, pasting.prompt);
    setBusy(false);
    if (sent.status === "error") setError(sent.error.message);
    else onDispatched(pasting.thread);
  };

  const asTerminal =
    settings !== null &&
    form !== null &&
    startsAsTerminal(settings, form.provider, issue);
  const set = (patch: Partial<DispatchForm>) =>
    setForm((f) => (f ? { ...f, ...patch } : f));

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <form
        className="modal dispatch-dialog"
        role="dialog"
        aria-label="Dispatch a task"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void dispatch();
        }}
      >
        <h2>
          {issue ? `Start a Thread from #${issue.number}` : "Dispatch a task"}
        </h2>
        {pasting ? (
          <>
            <p className="hint">
              {customAgentName(pasting.thread.provider, settings?.customAgents ?? [])} is running in
              its Thread. Oxide does not know how it takes a prompt, so this one is pasted into its
              terminal only when you ask, and never submitted: press Enter there yourself. The issue
              text is quoted and marked as external content.
            </p>
            <textarea readOnly rows={10} aria-label="Prompt to paste" value={pasting.prompt} />
            {error && <p role="alert" className="error">{error}</p>}
            <div className="modal-actions">
              <button type="button" className="btn" disabled={busy} onClick={() => onDispatched(pasting.thread)}>
                Skip
              </button>
              <button type="button" className="btn primary" disabled={busy} onClick={() => void paste()}>
                Paste into the terminal
              </button>
            </div>
          </>
        ) : form === null || settings === null ? (
          <Skeleton kind="form" label="Loading task settings…" />
        ) : (
          <>
            {asTerminal && isCustomProvider(form.provider) ? (
              <p className="hint">
                The agent starts with no prompt. You confirm the issue&apos;s prompt next, and it is
                pasted only if you ask.
              </p>
            ) : asTerminal ? (
              <p className="hint">
                The agent starts with the issue&apos;s number, title and body as
                its first prompt; the title and body are quoted and marked as
                external content.
              </p>
            ) : (
              <label>
                Prompt
                <textarea
                  autoFocus
                  rows={5}
                  value={form.prompt}
                  disabled={busy}
                  onChange={(e) => set({ prompt: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void dispatch();
                    }
                  }}
                />
              </label>
            )}
            <label>
              Provider
              <select
                value={form.provider}
                disabled={busy}
                onChange={(e) =>
                  setForm(withProvider(form, settings, e.target.value))
                }
              >
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
                {issue &&
                  (settings.customAgents ?? []).map((agent) => (
                    <option key={agent.id} value={customProviderId(agent)}>
                      {agent.name} (custom)
                    </option>
                  ))}
              </select>
            </label>
            {isCustomProvider(form.provider) ? (
              <p className="hint">{CUSTOM_AGENT_LIMITS}</p>
            ) : (
              <>
            <label>
              Model
              <input
                value={form.model}
                placeholder="Provider default"
                disabled={busy}
                onChange={(e) => set({ model: e.target.value })}
              />
            </label>
            <label>
              Effort
              <input
                value={form.effort}
                placeholder="Provider default"
                disabled={busy}
                onChange={(e) => set({ effort: e.target.value })}
              />
            </label>
            <label>
              Permission mode
              <select
                value={form.permissionMode}
                disabled={busy}
                onChange={(e) =>
                  set({ permissionMode: e.target.value as PermissionMode })
                }
              >
                {PERMISSION_MODES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
              </>
            )}
            {!asTerminal && (
              <label>
                Base branch
                <select
                  value={form.baseBranch}
                  disabled={busy}
                  onChange={(e) => set({ baseBranch: e.target.value })}
                >
                  {!branches.includes(form.baseBranch) && (
                    <option value={form.baseBranch}>
                      {form.baseBranch || "HEAD"}
                    </option>
                  )}
                  {branches.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {!asTerminal && (
              <p className="hint">
                Starts from the branch&apos;s commits; uncommitted changes are
                not carried over.
              </p>
            )}
          </>
        )}
        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            className={busy ? "pending" : undefined}
            disabled={
              busy ||
              form === null ||
              (!asTerminal && form.prompt.trim() === "")
            }
          >
            {busy ? "Dispatching…" : "Dispatch"}
          </button>
        </div>
      </form>
    </div>
  );
}
