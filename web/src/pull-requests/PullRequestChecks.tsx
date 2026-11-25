import {
  CheckCircleFillIcon,
  ChevronDownIcon,
  DotFillIcon,
  LinkExternalIcon,
  SkipIcon,
  SquareFillIcon,
  XCircleFillIcon,
} from "@primer/octicons-react";
import type { PullRequestCheck } from "../bindings";
import { countChecks, dedupeChecks, type CheckCounts } from "./pullRequestReview";

export const CHECK_WORD = {
  success: "Passed",
  failure: "Failed",
  pending: "Running",
  neutral: "Neutral",
  skipped: "Skipped",
} as const;

/** The order and wording of the counts, as GitHub's checks summary words them. The class names
 *  the bar segment and matches the check state it counts. */
const PARTS: { key: keyof CheckCounts; word: string; state: PullRequestCheck["state"] }[] = [
  { key: "failing", word: "failing", state: "failure" },
  { key: "pending", word: "running", state: "pending" },
  { key: "passing", word: "passed", state: "success" },
  { key: "neutral", word: "neutral", state: "neutral" },
  { key: "skipped", word: "skipped", state: "skipped" },
];

const describe = (counts: CheckCounts, separator: string) =>
  PARTS.filter((p) => counts[p.key] > 0)
    .map((p) => `${counts[p.key]} ${p.word}`)
    .join(separator);

/** Checks in a box: what needs attention is listed, what completed without failing folds into one
 *  row you can open. Neutral and skipped checks are counted apart from passed ones, never as passed.
 *  A check with a link opens its run on GitHub, to see what went wrong. */
export function Checks({ checks, onOpen }: { checks: PullRequestCheck[]; onOpen: (url: string) => void }) {
  const all = dedupeChecks(checks);
  // Once branch protection names required checks, the others are shown but do not hold the merge up.
  const hasRequired = checks.some((c) => c.required);
  if (all.length === 0) return null;
  const counts = countChecks(checks);
  const attention = all.filter((c) => c.state === "failure" || c.state === "pending");
  const completed = all.filter((c) => c.state !== "failure" && c.state !== "pending");
  const completedCounts = countChecks(completed);
  const inline = attention.length === 0 && completed.length <= 3;
  const foldedLabel =
    attention.length > 0
      ? describe(completedCounts, " · ")
      : completedCounts.passing === completed.length
        ? `All ${completed.length} passed`
        : `All ${completed.length} completed: ${describe(completedCounts, " · ")}`;
  const row = (c: PullRequestCheck) => <CheckRow key={c.name} check={c} optional={hasRequired && !c.required} onOpen={onOpen} />;
  return (
    <section className="pr-box pr-checks-box" aria-label="Checks">
      <header>
        <h4>Checks</h4>
        <span className="pr-checks-summary">{describe(counts, " · ")}</span>
        <span className="pr-bar" role="img" aria-label={describe(counts, ", ")}>
          {PARTS.filter((p) => counts[p.key] > 0).map((p) => (
            <i key={p.state} className={p.state} style={{ flexGrow: counts[p.key] }} />
          ))}
        </span>
      </header>
      {attention.length > 0 && <ul className="pr-checks">{attention.map(row)}</ul>}
      {completed.length > 0 &&
        (inline ? (
          <ul className="pr-checks">{completed.map(row)}</ul>
        ) : (
          <details className="pr-passed">
            <summary>
              <CheckCircleFillIcon size={14} className="pr-check-success" />
              {foldedLabel}
              <ChevronDownIcon size={14} className="pr-chev" />
            </summary>
            <ul className="pr-checks">{completed.map(row)}</ul>
          </details>
        ))}
    </section>
  );
}

function CheckIcon({ state }: { state: PullRequestCheck["state"] }) {
  switch (state) {
    case "success":
      return <CheckCircleFillIcon size={14} />;
    case "failure":
      return <XCircleFillIcon size={14} />;
    case "neutral":
      return <SquareFillIcon size={14} />;
    case "skipped":
      return <SkipIcon size={14} />;
    case "pending":
      return <DotFillIcon size={14} className="pr-pulse" />;
  }
}

function CheckRow({ check, optional, onOpen }: { check: PullRequestCheck; optional: boolean; onOpen: (url: string) => void }) {
  const body = (
    <>
      <CheckIcon state={check.state} />
      <span className="pr-check-name">{check.name}</span>
      {optional && <span className="pr-check-optional">Not required</span>}
      <span className="pr-check-state">{CHECK_WORD[check.state]}</span>
      {check.url && <LinkExternalIcon size={12} className="pr-check-open" />}
    </>
  );
  const url = check.url;
  return (
    <li className={`pr-check pr-check-${check.state}`}>
      {url ? (
        <button
          className="pr-check-link"
          title={check.state === "failure" ? "See what went wrong on GitHub" : "Open on GitHub"}
          aria-label={`${check.name}: ${CHECK_WORD[check.state]}. Open on GitHub`}
          onClick={() => onOpen(url)}
        >
          {body}
        </button>
      ) : (
        <div className="pr-check-link">{body}</div>
      )}
    </li>
  );
}
