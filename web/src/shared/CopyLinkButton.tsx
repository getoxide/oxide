import { CheckIcon, LinkIcon } from "@primer/octicons-react";
import { useEffect, useRef, useState } from "react";

interface CopyLinkButtonProps {
  url: string;
  onError: (message: string) => void;
}

const COPIED_RESET_MS = 2000;

/** Copies a GitHub URL to the clipboard with brief visual and screen-reader confirmation. */
export function CopyLinkButton({ url, onError }: CopyLinkButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  async function copy() {
    if (!navigator.clipboard?.writeText) {
      setCopied(false);
      onError("Clipboard is unavailable");
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), COPIED_RESET_MS);
    } catch (error) {
      setCopied(false);
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <>
      <button
        type="button"
        className="pr-github"
        data-copied={copied ? "true" : undefined}
        onClick={() => void copy()}
        title={copied ? "Copied link" : "Copy link"}
        aria-label="Copy link"
      >
        {copied ? <CheckIcon size={16} /> : <LinkIcon size={16} />}
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? "Copied link to clipboard" : ""}
      </span>
    </>
  );
}
