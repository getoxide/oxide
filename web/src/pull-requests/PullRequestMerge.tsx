import {
  AlertIcon,
  CheckCircleFillIcon,
  DotFillIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  SyncIcon,
  XCircleFillIcon,
} from "@primer/octicons-react";
import type { MergeMethod } from "../bindings";
import { SplitButton, SplitMenu, SplitMenuItem } from "../shared/SplitButton";
import { mergeLabel, type MergeRequirement, type Tone } from "./pullRequestReview";

/** The action in flight. Its button keeps its colour and shows a spinner; the others wait. */
export type Pending = "merge" | "auto" | "close" | "ready" | "update" | "comment" | "checkout" | "edit";

/** Button content while its work runs. */
export function Working({ on, label, children }: { on: boolean; label: string; children: React.ReactNode }) {
  return on ? (
    <>
      <SyncIcon size={14} className="spin" /> {label}
    </>
  ) : (
    <>{children}</>
  );
}

export function ToneIcon({ tone, size = 16 }: { tone: Tone; size?: number }) {
  if (tone === "ok") return <CheckCircleFillIcon size={size} />;
  if (tone === "bad") return <XCircleFillIcon size={size} />;
  if (tone === "warn") return <AlertIcon size={size} />;
  return <DotFillIcon size={size} />;
}

/** Why the pull request can or can't merge, laid out the way the web merge box does. */
export function MergeStatus({
  requirements,
  busy,
  updating,
  onUpdateBranch,
}: {
  requirements: MergeRequirement[];
  busy: boolean;
  updating: boolean;
  onUpdateBranch: () => void;
}) {
  if (requirements.length === 0) return null;
  return (
    <section className="pr-box pr-status-box" aria-label="Merge status">
      <ul>
        {requirements.map((r) => (
          <li key={r.kind} className={`pr-req pr-req-${r.tone}`}>
            <ToneIcon tone={r.tone} />
            <div>
              <p className="pr-req-title">{r.title}</p>
              {r.detail && r.tone !== "ok" && <p className="pr-req-detail">{r.detail}</p>}
            </div>
            {r.kind === "behind" && (
              <button className={updating ? "pending" : undefined} disabled={busy} onClick={onUpdateBranch}>
                <SyncIcon size={14} className={updating ? "spin" : undefined} /> {updating ? "Updating…" : "Update branch"}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

const METHOD_HELP: Record<MergeMethod, string> = {
  merge: "All commits are added to the base branch through a merge commit.",
  squash: "The commits are combined into one commit on the base branch.",
  rebase: "The commits are rebased and added onto the base branch.",
};

interface MergeFooterProps {
  draft: boolean;
  merged: boolean;
  methods: MergeMethod[];
  method: MergeMethod | null;
  head: string;
  deleteBranch: boolean;
  busy: boolean;
  pending: Pending | null;
  canMerge: boolean;
  /** Offer to merge by itself once the checks pass: the merge is blocked only by a wait. */
  canAutoMerge: boolean;
  autoMerge: boolean;
  tone: Tone;
  status: string;
  onMethod: (method: MergeMethod) => void;
  onDeleteBranch: (on: boolean) => void;
  /** Merges now, with this method (the menu's pick, remembered for the next time). */
  onMerge: (method: MergeMethod) => void;
  onAutoMerge: () => void;
  onReady: () => void;
  onClose: () => void;
}

/** Always in view: the verdict, one split button to merge (its menu holds the other methods,
 *  Merge when ready and Delete branch), and Close beside it. */
export function MergeFooter(p: MergeFooterProps) {
  const closeButton = (
    <button
      className={p.pending === "close" ? "pending" : undefined}
      disabled={p.busy}
      onClick={p.onClose}
      title="Close without merging"
    >
      <Working on={p.pending === "close"} label="Closing…">
        <GitPullRequestClosedIcon size={14} /> Close
      </Working>
    </button>
  );

  if (p.merged) {
    return (
      <footer className="pr-merge" aria-label="Merge">
        <p className="pr-merge-status ok">
          <CheckCircleFillIcon size={14} /> Merged
        </p>
      </footer>
    );
  }
  if (p.draft) {
    return (
      <footer className="pr-merge" aria-label="Merge">
        <p className="pr-merge-status neutral">
          <GitPullRequestDraftIcon size={14} /> Draft: not ready for review yet
        </p>
        <div className="pr-merge-row">
          <button className={`primary${p.pending === "ready" ? " pending" : ""}`} disabled={p.busy} onClick={p.onReady}>
            <Working on={p.pending === "ready"} label="Marking ready…">
              Ready for review
            </Working>
          </button>
          {closeButton}
        </div>
      </footer>
    );
  }
  if (p.method === null) {
    return (
      <footer className="pr-merge" aria-label="Merge">
        <p className="pr-merge-status">This repository allows no merge method.</p>
        <div className="pr-merge-row">{closeButton}</div>
      </footer>
    );
  }
  // Blocked only by a wait: what the user can do now is leave the merge to GitHub.
  const auto = p.canAutoMerge || p.autoMerge;
  const method = p.method;
  const pickHelp = (m: MergeMethod) =>
    p.canMerge ? METHOD_HELP[m] : p.canAutoMerge ? "Waits for the checks and reviews, then merges this way." : METHOD_HELP[m];
  return (
    <footer className="pr-merge" aria-label="Merge">
      <p className={`pr-merge-status ${p.tone}`}>
        <ToneIcon tone={p.tone} size={14} />
        {p.status}
      </p>
      <div className="pr-merge-row">
        <SplitButton
          label={
            auto ? (
              <Working on={p.pending === "auto"} label="Turning on…">
                <GitMergeIcon size={14} /> {p.autoMerge ? "Auto-merge on" : "Merge when ready"}
              </Working>
            ) : (
              <Working on={p.pending === "merge"} label="Merging…">
                <GitMergeIcon size={14} /> {mergeLabel(method)}
              </Working>
            )
          }
          title={auto ? "Merge by itself once the required checks pass" : undefined}
          onClick={auto ? p.onAutoMerge : () => p.onMerge(method)}
          disabled={p.autoMerge || (auto ? p.busy : !p.canMerge)}
          pending={p.pending === "merge" || p.pending === "auto"}
          menuDisabled={p.busy}
          risky={p.tone === "bad" && !auto}
          menuLabel="Merge options"
          width={320}
        >
          <SplitMenu label="Merge method">
            {p.methods.map((m) => (
              <SplitMenuItem
                key={m}
                title={mergeLabel(m)}
                help={pickHelp(m)}
                checked={m === method}
                onSelect={() => (p.canMerge ? p.onMerge(m) : p.onMethod(m))}
              />
            ))}
            {p.canAutoMerge && !p.autoMerge && (
              <SplitMenuItem
                title="Merge when ready"
                help="GitHub merges it by itself once the required checks pass."
                onSelect={p.onAutoMerge}
              />
            )}
          </SplitMenu>
          <div className="split-menu-section">
            <div className="pr-switch-row">
              <span>
                <strong id="delete-branch-label">Delete branch</strong>
                <small>
                  Removes <code>{p.head}</code> from GitHub after merging.
                </small>
              </span>
              <button
                role="switch"
                aria-checked={p.deleteBranch}
                aria-labelledby="delete-branch-label"
                className="pr-switch"
                disabled={p.busy}
                onClick={() => p.onDeleteBranch(!p.deleteBranch)}
              />
            </div>
          </div>
        </SplitButton>
        {closeButton}
      </div>
      {p.autoMerge && <p className="pr-merge-note">GitHub will merge it once the checks pass.</p>}
      {p.deleteBranch && !p.autoMerge && (
        <p className="pr-merge-note">
          <code>{p.head}</code> will be deleted after merging.
        </p>
      )}
    </footer>
  );
}
