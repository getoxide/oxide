import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  GitPullRequestIcon,
  SyncIcon,
} from "@primer/octicons-react";
import { commands, type PullRequest } from "../bindings";
import { BranchPicker } from "./BranchPicker";
import { describeCreatePrError } from "./createPullRequestError";
import { MarkdownEditor } from "../shared/MarkdownEditor";
import { useCandidates } from "./PullRequestPeople";

/** The key of a (head, base) pair in the commit counts. */
const pair = (head: string, base: string) => `${head}\u0000${base}`;

export function PullRequestCreate({
  projectId,
  onCancel,
  onCreated,
}: {
  projectId: number;
  onCancel: () => void;
  onCreated: (pr: PullRequest) => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  // Whether the user wrote their own title or description: then a new head leaves it alone.
  const edited = useRef({ title: false, body: false });
  const [base, setBase] = useState("");
  const [head, setHead] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [heads, setHeads] = useState<string[]>([]);
  const [isProtected, setIsProtected] = useState(false);
  // Commits each head has beyond each base checked so far, by pair(); null when Core cannot tell.
  const [ahead, setAhead] = useState<Record<string, number | null>>({});
  const [draft, setDraft] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const people = useCandidates(projectId);
  // The latest count asked for each pair, and the latest prefill asked for a head: an older
  // answer, or one asked before the form reloaded (another project, Try again), is dropped.
  const counting = useRef<{ next: number; latest: Record<string, number>; prefill: number }>({
    next: 0,
    latest: {},
    prefill: 0,
  });
  useEffect(() => {
    let active = true;
    counting.current.latest = {};
    counting.current.prefill = ++counting.current.next;
    void (async () => {
      try {
        const [defaults, bases] = await Promise.all([
          commands.pullRequestDraft(projectId, null),
          commands.pullRequestBaseBranches(projectId),
        ]);
        if (!active) return;
        if (defaults.status === "error")
          throw new Error(defaults.error.message);
        if (bases.status === "error") throw new Error(bases.error.message);
        setHead(defaults.data.head);
        setHeads(defaults.data.heads);
        setTitle(defaults.data.title);
        setBody(defaults.data.body);
        edited.current = { title: false, body: false };
        setBase(defaults.data.base);
        setIsProtected(defaults.data.protected);
        setAhead({ [pair(defaults.data.head, defaults.data.base)]: defaults.data.commitsBeyond });
        setBranches([...new Set([defaults.data.base, ...bases.data])]);
      } catch (cause) {
        if (active)
          setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [projectId, retry]);
  // Asks local Git again how many commits `from` has beyond `onto`.
  const recount = useCallback(
    (from: string, onto: string) => {
      const key = pair(from, onto);
      const asked = ++counting.current.next;
      counting.current.latest[key] = asked;
      void commands
        .pullRequestCommitsBeyond(projectId, from, onto)
        .then((result) => (result.status === "ok" ? result.data : null))
        .catch(() => null)
        .then((count) => {
          if (counting.current.latest[key] !== asked) return;
          setAhead((known) => ({ ...known, [key]: count }));
        });
    },
    [projectId],
  );
  // Counts the pair unless a count above zero is known: that only grows with new commits,
  // while zero or unknown may be stale.
  function count(from: string, onto: string) {
    if (from === onto) return;
    const known = ahead[pair(from, onto)];
    if (typeof known === "number" && known > 0) return;
    recount(from, onto);
  }
  function chooseBase(next: string) {
    setBase(next);
    count(head, next);
  }
  function chooseHead(next: string) {
    setHead(next);
    count(next, base);
    if (edited.current.title && edited.current.body) return;
    // The prefill follows the head while the user has not written their own.
    const asked = ++counting.current.next;
    counting.current.prefill = asked;
    void commands
      .pullRequestDraft(projectId, next)
      .then((result) => {
        if (counting.current.prefill !== asked || result.status !== "ok") return;
        if (!edited.current.title) setTitle(result.data.title);
        if (!edited.current.body) setBody(result.data.body);
      })
      .catch(() => {});
  }
  // The user may commit in a Terminal meanwhile: count again when the window comes back.
  useEffect(() => {
    if (loading || base === "" || head === "" || head === base) return;
    const onFocus = () => recount(head, base);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loading, head, base, recount]);
  // Why no pull request can be opened from here, if it cannot.
  // Core refuses to push or open a pull request from a protected head, whatever it holds.
  const blocker = isProtected
    ? "noHead"
    : head !== "" && head === base
      ? "same"
      : ahead[pair(head, base)] === 0
        ? "noDiff"
        : null;
  // The count for a newly chosen pair is still on its way.
  const checking = base !== "" && head !== base && !(pair(head, base) in ahead);
  const canCreate =
    !busy && !loading && title.trim() !== "" && base !== "" && head !== "" && !blocker && !checking;
  async function submit() {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const result = await commands.createPullRequest(projectId, {
        title: title.trim(),
        body,
        base,
        head,
        draft,
      });
      if (result.status === "error") setError(result.error.message);
      else onCreated(result.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  const diagnostic = error ? describeCreatePrError(error, base) : null;
  return (
    <form
      className="pr-create"
      aria-label="Create pull request"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <header className="pr-compose-heading">
        <button
          type="button"
          className="icon-btn sm"
          disabled={busy}
          onClick={onCancel}
          aria-label="Back to pull requests"
        >
          <ArrowLeftIcon size={16} />
        </button>
        <h2>New pull request</h2>
      </header>
      {loading ? (
        <p role="status">Preparing your branch…</p>
      ) : (
        <>
          <div className="pr-compose-branches">
            <BranchPicker
              label="Head branch"
              value={head}
              branches={heads}
              disabled={busy || heads.length === 0}
              onChange={chooseHead}
            />
            <ArrowRightIcon size={14} className="pr-compose-arrow" aria-label="into" />
            <BranchPicker
              label="Base branch"
              value={base}
              branches={branches}
              disabled={busy}
              onChange={chooseBase}
            />
          </div>
          <label className="pr-create-title">
            Title
            <input
              autoFocus
              required
              value={title}
              disabled={busy}
              onChange={(e) => {
                setTitle(e.target.value);
                edited.current.title = true;
              }}
              placeholder="What does this change?"
            />
          </label>
          <MarkdownEditor
            label="Description"
            value={body}
            onChange={(next) => {
              setBody(next);
              edited.current.body = true;
            }}
            disabled={busy}
            placeholder="Describe the change and how you tested it."
            rows={9}
            mentions={people.candidates.state === "ready" ? people.candidates.data.users : []}
            onMentionOpen={people.load}
          />
          <label className="pr-create-draft">
            <input
              type="checkbox"
              checked={draft}
              disabled={busy}
              onChange={(e) => setDraft(e.target.checked)}
            />{" "}
            Create as draft
          </label>
          {blocker === "noHead" ? (
            <p className="pr-create-hint" id="pr-create-hint">
              Create a feature branch to open a pull request:{" "}
              <span className="mono">{head}</span> can’t be the head.
            </p>
          ) : blocker === "same" ? (
            <p className="pr-create-hint" id="pr-create-hint">
              The head and the base are the same branch. Choose a different head or base.
            </p>
          ) : blocker === "noDiff" ? (
            <p className="pr-create-hint" id="pr-create-hint">
              No commits on <span className="mono">{head}</span> beyond{" "}
              <span className="mono">{base}</span>. Commit changes before
              creating a pull request.
            </p>
          ) : (
            <p className="dim">
              <span className="mono">{head}</span> will be pushed before the
              pull request is created.
            </p>
          )}
          <button
            className="btn primary"
            type="submit"
            aria-describedby={blocker ? "pr-create-hint" : undefined}
            disabled={!canCreate}
          >
            {busy ? (
              <SyncIcon size={14} className="spin" />
            ) : (
              <GitPullRequestIcon size={14} />
            )}
            {busy
              ? "Creating…"
              : draft
                ? "Create draft pull request"
                : "Create pull request"}
          </button>
        </>
      )}
      {diagnostic && (
        <div role="alert" className="pr-create-error">
          <strong>{diagnostic.title}</strong>
          <p>{diagnostic.guidance}</p>
          <details>
            <summary>Details</summary>
            <pre>{error}</pre>
          </details>
          {!base && (
            <button
              type="button"
              onClick={() => {
                setLoading(true);
                setError(null);
                setRetry((n) => n + 1);
              }}
            >
              Try again
            </button>
          )}
        </div>
      )}
    </form>
  );
}
