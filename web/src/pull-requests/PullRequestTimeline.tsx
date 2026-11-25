import type { ReactNode } from "react";
import {
  CrossReferenceIcon,
  EyeClosedIcon,
  EyeIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitMergeIcon,
  GitPullRequestDraftIcon,
  IssueClosedIcon,
  IssueReopenedIcon,
  PencilIcon,
  PersonIcon,
  RepoPushIcon,
  SkipIcon,
  TagIcon,
  VerifiedIcon,
} from "@primer/octicons-react";
import type { TimelineItem } from "../bindings";
import { Avatar } from "../shared/Avatar";
import { relativeTime } from "../shared/relativeTime";
import { LabelChip } from "./PullRequestPeople";

type Kind<K extends TimelineItem["kind"]> = Extract<TimelineItem, { kind: K }>;
/** The entries shown as cards with a body; every other kind is a compact activity row. */
export type ConversationItem = Kind<"comment" | "review">;
export type ActivityItem = Exclude<TimelineItem, ConversationItem>;

export function isConversationItem(item: TimelineItem): item is ConversationItem {
  return item.kind === "comment" || item.kind === "review";
}

const CLOSE_REASON: Record<string, string> = {
  COMPLETED: " as completed",
  NOT_PLANNED: " as not planned",
  DUPLICATE: " as a duplicate",
};

/** A link-styled button that opens a GitHub page through the external-link flow. */
function LinkButton({ url, onOpen, children, className }: {
  url: string;
  onOpen: (url: string) => void;
  children: ReactNode;
  className?: string;
}) {
  if (!url) return <span className={className}>{children}</span>;
  return (
    <button type="button" className={`pr-timeline-link${className ? ` ${className}` : ""}`} title={url} onClick={() => onOpen(url)}>
      {children}
    </button>
  );
}

function Row({ icon, actor, at, children }: { icon: ReactNode; actor?: string; at: string; children: ReactNode }) {
  return (
    <div className="pr-timeline-event">
      <span className="pr-timeline-icon" aria-hidden="true">
        {icon}
      </span>
      <p className="pr-timeline-text">
        {actor && (
          <>
            <Avatar login={actor} size={16} /> <strong>{actor}</strong>{" "}
          </>
        )}
        {children}{" "}
        <time dateTime={at}>{relativeTime(at)}</time>
      </p>
    </div>
  );
}

/** One compact activity row of the Conversation, as GitHub's timeline shows it. `head` names
 *  the pull request's branch for the branch deleted and restored events. */
export function ActivityRow({ item, head, onOpen }: { item: ActivityItem; head?: string; onOpen: (url: string) => void }) {
  switch (item.kind) {
    case "commit":
      return (
        <div className="pr-timeline-event pr-timeline-commit">
          <span className="pr-timeline-icon" aria-hidden="true">
            <GitCommitIcon size={14} />
          </span>
          <p className="pr-timeline-text">
            <Avatar login={item.author} size={16} /> <span className="pr-timeline-headline">{item.headline}</span>{" "}
            <span className="pr-timeline-meta">{item.author}</span>
          </p>
          {item.verified && (
            <span className="pr-timeline-verified" title="This commit was signed with a verified signature">
              <VerifiedIcon size={12} /> Verified
            </span>
          )}
          {item.status && <span className={`pr-timeline-status ${item.status}`} role="img" aria-label={`Checks: ${item.status}`} />}
          <LinkButton url={item.url} onOpen={onOpen} className="pr-timeline-sha">
            {item.abbreviatedOid}
          </LinkButton>
        </div>
      );
    case "forcePush":
      return (
        <Row icon={<RepoPushIcon size={14} />} actor={item.actor} at={item.createdAt}>
          force-pushed the <code>{item.branch}</code> branch from <code>{item.before || "an unknown commit"}</code> to{" "}
          <code>{item.after || "an unknown commit"}</code>
          {item.compareUrl && (
            <>
              {" "}
              <LinkButton url={item.compareUrl} onOpen={onOpen}>
                Compare
              </LinkButton>
            </>
          )}
        </Row>
      );
    case "assigned":
      return (
        <Row icon={<PersonIcon size={14} />} actor={item.actor} at={item.createdAt}>
          {item.actor === item.login ? "self-assigned this" : <>assigned <strong>{item.login}</strong></>}
        </Row>
      );
    case "unassigned":
      return (
        <Row icon={<PersonIcon size={14} />} actor={item.actor} at={item.createdAt}>
          {item.actor === item.login ? "removed their assignment" : <>unassigned <strong>{item.login}</strong></>}
        </Row>
      );
    case "labeled":
    case "unlabeled":
      return (
        <Row icon={<TagIcon size={14} />} actor={item.actor} at={item.createdAt}>
          {item.kind === "labeled" ? "added" : "removed"} the <LabelChip label={item.label} /> label
        </Row>
      );
    case "reviewRequested":
      return (
        <Row icon={<EyeIcon size={14} />} actor={item.actor} at={item.createdAt}>
          requested a review from <strong>{item.login}</strong>
        </Row>
      );
    case "reviewRequestRemoved":
      return (
        <Row icon={<EyeClosedIcon size={14} />} actor={item.actor} at={item.createdAt}>
          removed the review request for <strong>{item.login}</strong>
        </Row>
      );
    case "closed":
      return (
        <Row
          icon={item.stateReason === "NOT_PLANNED" ? <SkipIcon size={14} /> : <IssueClosedIcon size={14} />}
          actor={item.actor}
          at={item.createdAt}
        >
          closed this{CLOSE_REASON[item.stateReason] ?? ""}
        </Row>
      );
    case "reopened":
      return (
        <Row icon={<IssueReopenedIcon size={14} />} actor={item.actor} at={item.createdAt}>
          reopened this
        </Row>
      );
    case "merged":
      return (
        <Row icon={<GitMergeIcon size={14} />} actor={item.actor} at={item.createdAt}>
          merged commit <code>{item.commit}</code> into <code>{item.base}</code>
        </Row>
      );
    case "convertedToDraft":
      return (
        <Row icon={<GitPullRequestDraftIcon size={14} />} actor={item.actor} at={item.createdAt}>
          marked this pull request as draft
        </Row>
      );
    case "readyForReview":
      return (
        <Row icon={<EyeIcon size={14} />} actor={item.actor} at={item.createdAt}>
          marked this pull request as ready for review
        </Row>
      );
    case "renamed":
      return (
        <Row icon={<PencilIcon size={14} />} actor={item.actor} at={item.createdAt}>
          changed the title <del>{item.from}</del> <ins>{item.to}</ins>
        </Row>
      );
    case "headRefDeleted":
    case "headRefRestored":
      return (
        <Row icon={<GitBranchIcon size={14} />} actor={item.actor} at={item.createdAt}>
          {item.kind === "headRefDeleted" ? "deleted" : "restored"} the {head ? <code>{head}</code> : "head"} branch
        </Row>
      );
    case "crossReferenced":
      return (
        <Row icon={<CrossReferenceIcon size={14} />} actor={item.actor} at={item.createdAt}>
          mentioned this in{" "}
          <LinkButton url={item.url} onOpen={onOpen}>
            <span className="pr-timeline-ref">
              {item.crossRepository ? item.repository : ""}#{item.number}
            </span>{" "}
            {item.title}
          </LinkButton>{" "}
          <span className={`pr-timeline-state ${item.state.toLowerCase()}`}>{item.state.toLowerCase()}</span>
        </Row>
      );
  }
}
