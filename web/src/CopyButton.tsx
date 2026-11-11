import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "@primer/octicons-react";

/** How long a copy stays confirmed before reverting to the copy icon. */
export const COPIED_MS = 2000;

/**
 * Copies `text` to the clipboard, swapping its icon for a checkmark and showing
 * "Copied!" for two seconds. Keyboard-focusable like any button, and labelled
 * for screen readers with what is being copied.
 */
export function CopyButton({
  text,
  label,
  className,
}: {
  text: string;
  label: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = () => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => {
          setCopied(false);
          timer.current = null;
        }, COPIED_MS);
      })
      .catch(() => {
        // The clipboard refused; leave the button as it was.
      });
  };

  return (
    <button
      type="button"
      className={`icon-btn sm copy-btn${copied ? " copied" : ""}${className ? ` ${className}` : ""}`}
      aria-label={`Copy ${label}`}
      title={copied ? "Copied!" : `Copy ${label}`}
      onClick={copy}
    >
      {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
      {copied && <span className="copy-btn-label">Copied!</span>}
    </button>
  );
}
