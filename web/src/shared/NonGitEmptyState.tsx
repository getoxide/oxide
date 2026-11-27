import { RepoIcon } from "@primer/octicons-react";

export type RepositoryIssueKind = "not-git" | "no-remote";

export function classifyRepositoryError(message: string): RepositoryIssueKind | null {
  if (/not a git repository/i.test(message)) return "not-git";
  if (/no git remotes found|none of the git remotes.*github|could not resolve to a repository/i.test(message)) {
    return "no-remote";
  }
  return null;
}

export function isGithubAuthOrSetupError(message: string): boolean {
  return /install the github cli|not logged in|gh auth login|authentication|not installed/i.test(message);
}

export function NonGitEmptyState({
  kind,
  surface,
}: {
  kind: RepositoryIssueKind;
  surface: "issues" | "pull-requests";
}) {
  const surfaceName = surface === "issues" ? "Issues" : "Pull requests";
  const title = kind === "not-git" ? "Not a Git repository" : "No GitHub remote";
  const description =
    kind === "not-git"
      ? `This folder isn’t a Git repository. Terminals and Files work normally here — GitHub ${surfaceName} will appear once this folder is a Git repository connected to GitHub.`
      : `This Git repository isn’t connected to GitHub yet. Add a GitHub remote to view ${surfaceName} here.`;

  return (
    <div className="pr-empty surface-empty">
      <RepoIcon size={32} />
      <p className="surface-empty-title">{title}</p>
      <p className="surface-empty-description">{description}</p>
    </div>
  );
}
