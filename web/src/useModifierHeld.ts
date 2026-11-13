import { useEffect, useState } from "react";
import { isMacPlatform } from "./shortcuts";

/** How long the modifier must be held alone before badges show: long enough to type a shortcut. */
const REVEAL_DELAY_MS = 600;

/**
 * Whether the primary modifier is held: ⌘ on macOS, Ctrl elsewhere. Badges show after a short
 * delay and disappear the instant the key is released, so the UI stays clean during shortcuts.
 */
export function useModifierHeld(): boolean {
  const [held, setHeld] = useState(false);
  const primaryKey = isMacPlatform ? "Meta" : "Control";

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cancelTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const hide = () => {
      cancelTimer();
      setHeld(false);
    };
    const show = () => {
      cancelTimer();
      setHeld(true);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        hide();
      } else if (event.key === primaryKey) {
        if (timer === null) timer = setTimeout(show, REVEAL_DELAY_MS);
      } else if ((isMacPlatform && event.metaKey) || (!isMacPlatform && event.ctrlKey)) {
        // The modifier is part of a shortcut being typed: the user knows it, so no badges.
        cancelTimer();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === primaryKey) hide();
    };
    const onBlur = () => hide();

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      cancelTimer();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [primaryKey]);

  return held;
}
