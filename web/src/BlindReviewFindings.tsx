import { useEffect, useState } from "react";
import { EyeIcon } from "@primer/octicons-react";
import { commands, type BlindReviewFinding, type BlindReviewRun } from "./bindings";
import { commentsPrefix } from "./LineComments";
import { invalidateQueries, useQuery, type QueryResult } from "./queryCache";

interface Props {
  projectId: number;
  threadId: number;
  /** Changes when the Thread or its review does, so a fresh reply is parsed. */
  refreshKey: string;
}

/** Cache prefix of a Thread's Blind review findings, refreshed by the review and by keep/dismiss. */
export const blindReviewFindingsPrefix = (projectId: number) => `p${projectId}:blindFindings:`;
/** Cache prefix of a Thread's Blind reviews (running, finished or failed). */
export const blindReviewRunsPrefix = (projectId: number) => `p${projectId}:blindRuns:`;

/** The findings of the Blind reviews of a Thread, each kept or dismissed by the reviewer. */
export function BlindReviewFindings({ projectId, threadId, refreshKey }: Props) {
  const query = useQuery(
    `${blindReviewFindingsPrefix(projectId)}${threadId}`,
    async (): Promise<QueryResult<BlindReviewFinding[]>> =>
      commands.listBlindReviewFindings(threadId),
    refreshKey,
  );
  const runsQuery = useQuery(
    `${blindReviewRunsPrefix(projectId)}${threadId}`,
    async (): Promise<QueryResult<BlindReviewRun[]>> => commands.listBlindReviews(threadId),
    refreshKey,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const findings = query.state === "ready" ? (query.data ?? []) : [];
  const runs = runsQuery.state === "ready" ? (runsQuery.data ?? []) : [];
  const running = runs.filter((r) => r.status === "running");
  const failed = runs.filter((r) => r.status === "failed").slice(-1);
  const isRunning = running.length > 0;
  // The review runs in the background: look again until it ends.
  useEffect(() => {
    if (!isRunning) return;
    const timer = setInterval(() => {
      invalidateQueries(blindReviewFindingsPrefix(projectId));
      invalidateQueries(blindReviewRunsPrefix(projectId));
    }, 2000);
    return () => clearInterval(timer);
  }, [isRunning, projectId]);
  // A kept anchored finding is a Line comment in the list below, so showing it here too would
  // duplicate it.
  const visible = findings.filter((f) => {
    if (f.decision === "dismissed") return false;
    if (f.decision === "kept" && !f.plain) return false;
    return true;
  });
  if (visible.length === 0 && !isRunning && failed.length === 0) return null;
  const pending = findings.filter((f) => f.decision === "pending").length;

  const refresh = () => {
    invalidateQueries(blindReviewFindingsPrefix(projectId));
    invalidateQueries(commentsPrefix(projectId));
  };
  async function decide(finding: BlindReviewFinding, keep: boolean) {
    setError(null);
    setBusy(finding.id);
    const result = keep
      ? await commands.keepBlindReviewFinding(finding.id)
      : await commands.dismissBlindReviewFinding(finding.id);
    setBusy(null);
    if (result.status === "error") setError(result.error.message);
    else refresh();
  }

  return (
    <section className="blind-findings" aria-label="Blind review findings">
      <header className="line-comments-head">
        <EyeIcon size={14} />
        <strong>
          {pending} finding{pending === 1 ? "" : "s"} to review
        </strong>
        <span className="grow" />
      </header>
      {isRunning && (
        <p className="hint" role="status">
          Blind review running with {running.map((r) => r.provider).join(", ")}…
        </p>
      )}
      {failed.map((run) => (
        <div key={run.id} className="error" role="alert">
          Blind review with {run.provider} failed{run.error ? `: ${run.error}` : "."}
        </div>
      ))}
      <ul className="line-comment-list">
        {visible.map((finding) => (
          <li
            key={finding.id}
            className="line-comment"
            aria-label={`Blind review finding from ${finding.provider}`}
          >
            <div className="line-comment-where">
              <span className="mono">{finding.provider} review</span>
              {finding.path !== null && finding.line !== null ? (
                <span className="mono">
                  {finding.path}:{finding.line}
                </span>
              ) : (
                <span className="chip warn" title="Oxide could not anchor this to the Diff.">
                  Plain text
                </span>
              )}
              {finding.decision === "kept" && (
                <span className="chip">
                  {finding.plain ? "Kept as plain text" : "Kept as a draft"}
                </span>
              )}
            </div>
            {finding.code !== "" && (
              <pre className="line-comment-code mono">{finding.code}</pre>
            )}
            <p className="line-comment-body">{finding.body}</p>
            {finding.decision === "pending" && (
              <div className="line-comment-actions">
                <button
                  type="button"
                  className="btn sm primary"
                  aria-label={`Keep finding ${finding.id}`}
                  disabled={busy === finding.id}
                  onClick={() => void decide(finding, true)}
                >
                  Keep
                </button>
                <button
                  type="button"
                  className="btn sm"
                  aria-label={`Dismiss finding ${finding.id}`}
                  disabled={busy === finding.id}
                  onClick={() => void decide(finding, false)}
                >
                  Dismiss
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
