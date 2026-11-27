import { useCallback, useEffect, useState } from "react";
import { CheckCircleIcon, LinkExternalIcon, MarkGithubIcon } from "@primer/octicons-react";
import { commands, type DeveloperTool, type GithubAccountStatus } from "../bindings";
import { openExternalLink } from "../shared/externalLink";
import { copyTextToClipboard } from "../shared/platform";

export function GithubSettingsSection() {
  const [tools, setTools] = useState<DeveloperTool[] | null>(null);
  const [account, setAccount] = useState<GithubAccountStatus | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    const [toolsResult, accountResult] = await Promise.all([
      commands.developerTools(),
      commands.githubAccountStatus(),
    ]);
    if (toolsResult.status === "error") throw new Error(toolsResult.error.message);
    return {
      tools: toolsResult.data,
      account:
        accountResult.status === "ok"
          ? accountResult.data
          : { authenticated: false, username: null, host: null },
    };
  }, []);

  const recheck = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      const next = await fetchStatus();
      setTools(next.tools);
      setAccount(next.account);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }, [fetchStatus]);

  useEffect(() => {
    let active = true;
    void fetchStatus()
      .then((next) => {
        if (!active) return;
        setTools(next.tools);
        setAccount(next.account);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [fetchStatus]);

  const install = async (tool: DeveloperTool) => {
    setInstalling(tool.id);
    setError(null);
    try {
      const result = await commands.installDeveloperTool(tool.id);
      if (result.status === "error") throw new Error(result.error.message);
      await recheck();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(null);
    }
  };

  const ghInstalled = tools?.some((tool) => tool.id === "gh" && tool.installed) ?? false;
  const bothInstalled = tools !== null && tools.length === 2 && tools.every((tool) => tool.installed);

  let accountPillClass = "muted";
  let accountPillLabel = "Checking…";
  let accountNote = "Checking GitHub CLI authentication status…";

  if (tools !== null && !ghInstalled) {
    accountPillClass = "muted";
    accountPillLabel = "Setup required";
    accountNote = "Install Git and the GitHub CLI below to connect your account.";
  } else if (account?.authenticated) {
    accountPillClass = "ok";
    accountPillLabel = "Connected";
    accountNote = account.username
      ? `Signed in as @${account.username} on ${account.host ?? "github.com"}.`
      : `Signed in on ${account.host ?? "github.com"}.`;
  } else if (account !== null) {
    accountPillClass = "warn";
    accountPillLabel = "Not signed in";
    accountNote = "Run `gh auth login` in a terminal to sign in.";
  }

  return (
    <div className="github-settings">
      <div className="settings-card">
        <div className="settings-item github-account-row">
          <div className="github-account-info">
            <MarkGithubIcon size={20} className="github-account-icon" />
            <div className="settings-item-label">
              <span className="github-account-title">
                <strong>GitHub account</strong>
                <span className={`github-status-pill ${accountPillClass}`}>{accountPillLabel}</span>
              </span>
              <span className="settings-note">{accountNote}</span>
            </div>
          </div>
          <div className="settings-item-controls">
            {ghInstalled && account && !account.authenticated && (
              <button
                type="button"
                className="btn sm primary"
                onClick={() => {
                  void copyTextToClipboard("gh auth login --web --git-protocol https").then((ok) => {
                    if (ok) setCopied(true);
                    else setError("Could not copy sign-in command to clipboard.");
                  });
                }}
              >
                {copied ? "Copied — run in terminal" : "Copy sign-in command"}
              </button>
            )}
            <button
              type="button"
              className="btn sm"
              disabled={checking || installing !== null}
              onClick={() => void recheck()}
            >
              {checking ? "Checking…" : "Recheck"}
            </button>
          </div>
        </div>
      </div>

      <h3 className="settings-group-title">CLI tools</h3>
      <div className="settings-card">
        {!tools && !error && (
          <div className="settings-item">
            <span className="settings-note">Checking installed tools…</span>
          </div>
        )}
        {tools?.map((tool) => (
          <div key={tool.id} className="settings-item">
            <div className="settings-item-label">
              <strong>{tool.name}</strong>
              <span className="settings-note">
                {tool.id === "git"
                  ? "Version control and local repositories."
                  : "Pull requests, issues, and your GitHub account."}
              </span>
              {tool.installed && tool.path && (
                <code className="github-tool-path" title={tool.path}>
                  {tool.path}
                </code>
              )}
            </div>
            <div className="settings-item-controls">
              {tool.installed ? (
                <span className="github-status-pill ok">
                  <CheckCircleIcon size={13} /> Installed
                </span>
              ) : tool.canInstall ? (
                <button
                  type="button"
                  className="btn sm"
                  disabled={installing !== null || checking}
                  onClick={() => void install(tool)}
                >
                  {installing === tool.id ? "Installing…" : `Install ${tool.name}`}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn sm"
                  disabled={installing !== null}
                  onClick={() =>
                    void openExternalLink(tool.documentation)
                      .then((message) => {
                        if (message) setError(message);
                      })
                      .catch((e) => setError(String(e)))
                  }
                >
                  Installation guide <LinkExternalIcon size={12} />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {installing && (
        <p role="status" className="settings-note">
          Installing with your system package manager. The installer may ask for permission. This can take a few minutes.
        </p>
      )}
      {!bothInstalled && tools?.some((tool) => !tool.installed && !tool.canInstall) && (
        <p className="settings-note">
          Use the official installer, then click Recheck. If the tool is still missing, restart Oxide to refresh its PATH.
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
