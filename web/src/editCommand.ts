export type EditCommand = "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll";

function isTextControl(target: Element | null): target is HTMLInputElement | HTMLTextAreaElement {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

function isEditableElement(target: Element | null): target is HTMLElement {
  return target instanceof HTMLElement && (target.isContentEditable || target.contentEditable === "true");
}

function selectAllInNode(node: Node) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
}

function writeClipboard(text: string) {
  if (text) void navigator.clipboard?.writeText(text).catch(() => {});
}

function readClipboard(apply: (text: string) => void) {
  void navigator.clipboard
    ?.readText()
    .then((text) => {
      if (text) apply(text);
    })
    .catch(() => {});
}

interface EditTarget {
  selectAll(): void;
  selectedText(): string;
  replaceSelection: ((text: string) => void) | null;
}

function inputTarget(el: HTMLInputElement | HTMLTextAreaElement): EditTarget {
  const editable = !el.readOnly && !el.disabled;
  return {
    selectAll: () => el.select(),
    selectedText: () => el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0),
    replaceSelection: editable
      ? (text) => {
          el.setRangeText(text, el.selectionStart ?? 0, el.selectionEnd ?? 0, "end");
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
      : null,
  };
}

function domTarget(target: Element | null): EditTarget {
  const editable = isEditableElement(target) ? target : null;
  return {
    selectAll: () => selectAllInNode(editable ?? document.body),
    selectedText: () => window.getSelection()?.toString() ?? "",
    replaceSelection: editable
      ? (text) => {
          const selection = window.getSelection();
          if (!selection || selection.rangeCount === 0) return;
          const range = selection.getRangeAt(0);
          range.deleteContents();
          if (text) {
            const node = document.createTextNode(text);
            range.insertNode(node);
            range.setStartAfter(node);
          }
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
          editable.dispatchEvent(new Event("input", { bubbles: true }));
        }
      : null,
  };
}

/** Handles Edit menu commands via Monaco's custom event first, then Clipboard API and native selection. */
export function runEditCommand(command: EditCommand, target: Element | null = document.activeElement) {
  if (!window.dispatchEvent(new CustomEvent("oxide-editor-edit", { detail: command, cancelable: true }))) {
    return;
  }
  const adapter = isTextControl(target) ? inputTarget(target) : domTarget(target);
  switch (command) {
    case "selectAll":
      adapter.selectAll();
      return;
    case "copy":
      writeClipboard(adapter.selectedText());
      return;
    case "cut": {
      if (!adapter.replaceSelection) return;
      const text = adapter.selectedText();
      if (!text) return;
      writeClipboard(text);
      adapter.replaceSelection("");
      return;
    }
    case "paste": {
      const replace = adapter.replaceSelection;
      if (!replace) return;
      readClipboard(replace);
      return;
    }
    case "undo":
    case "redo":
      return;
  }
}
