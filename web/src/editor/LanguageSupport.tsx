import { readText, storageKeys, writeText } from "../shared/storage";
import { useEffect, useState } from "react";
import { Channel } from "../shared/ipc";
import {
  CodeIcon,
  DownloadIcon,
  SyncIcon,
  XIcon,
} from "@primer/octicons-react";
import { commands, type LanguageTool } from "../bindings";

export function InstallLanguageButton({
  tool,
  onInstalled,
}: {
  tool: LanguageTool;
  onInstalled: () => void;
}) {
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function install() {
    setProgress("Preparing download…");
    setError(null);
    const channel = new Channel<string>();
    channel.onmessage = setProgress;
    try {
      const result = await commands.installLanguageSupport(
        tool.language,
        channel,
      );
      if (result.status === "error") throw new Error(result.error.message);
      window.dispatchEvent(new Event("oxide-language-tools-changed"));
      onInstalled();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
    }
  }
  return (
    <div className="language-download">
      <button
        className="btn primary"
        disabled={progress !== null}
        onClick={() => void install()}
      >
        {progress ? (
          <SyncIcon size={14} className="spin" />
        ) : (
          <DownloadIcon size={14} />
        )}
        {progress
          ? "Installing…"
          : tool.installed
            ? "Reinstall support"
            : "Install support"}
      </button>
      {progress && <span role="status">{progress}</span>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** A small, dismissible first-use invitation, following the language of the current file. */
export function LanguageSupportNotice({
  language,
}: {
  language: string;
}) {
  const [tool, setTool] = useState<LanguageTool | null>(null);
  const [dismissed, setDismissed] = useState(
    () => readText(storageKeys.languageDismissed(language)) === "true",
  );
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void commands
        .languageTools()
        .then((tools) => {
          if (active)
            setTool(tools.find((t) => t.language === language) ?? null);
        })
        .catch(() => {});
    };
    refresh();
    window.addEventListener("oxide-language-tools-changed", refresh);
    return () => {
      active = false;
      window.removeEventListener("oxide-language-tools-changed", refresh);
    };
  }, [language]);
  if (!tool || tool.installed || dismissed) return null;
  return (
    <aside
      className="language-support-notice"
      aria-label="Language support available"
    >
      <CodeIcon size={18} />
      <div className="grow">
        <strong>{tool.name} support is available</strong>
        <p>
          Download local language tools for diagnostics, completion and
          navigation.
        </p>
      </div>
      <InstallLanguageButton
        tool={tool}
        onInstalled={() => setTool({ ...tool, installed: true })}
      />
      <button
        className="icon-btn sm"
        aria-label="Set up language support later"
        onClick={() => {
          setDismissed(true);
          // Dismissed for this view even when storage refuses the write.
          writeText(storageKeys.languageDismissed(language), "true");
        }}
      >
        <XIcon size={14} />
      </button>
    </aside>
  );
}
