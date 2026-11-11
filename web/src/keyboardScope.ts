/** Focus here already owns the keystrokes: an input, a code editor, or any editable surface. */
const TYPING_TARGETS =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .monaco-editor, .xterm, .terminal';

/** An open modal, popover or palette owns the interaction, so keys must not reach behind it. */
const OPEN_DIALOGS = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], .modal-backdrop';

export function isTypingTarget(target: Element | null): boolean {
  return Boolean(target?.closest(TYPING_TARGETS));
}

export function hasOpenDialog(): boolean {
  return Boolean(document.querySelector(OPEN_DIALOGS));
}
