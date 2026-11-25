import type { RefObject } from "react";
import { Popover } from "../shared/Popover";

/** The status bar's language control: the buffer's language mode and its language server. */
export function LanguagePopover({
  anchor,
  onClose,
}: {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  return (
    <Popover anchor={anchor} label="Language" onClose={onClose}>
      <div className="language-popover" />
    </Popover>
  );
}
