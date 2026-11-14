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

function runInputCommand(command: EditCommand, el: HTMLInputElement | HTMLTextAreaElement) {
  const editable = !el.readOnly && !el.disabled;
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  switch (command) {
    case "selectAll":
      el.select();
      return;
    case "copy":
      writeClipboard(el.value.slice(start, end));
      return;
    case "cut":
      if (!editable || start === end) return;
      writeClipboard(el.value.slice(start, end));
      el.setRangeText("", start, end, "end");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    case "paste":
      if (!editable) return;
      readClipboard((text) => {
        const from = el.selectionStart ?? start;
        const to = el.selectionEnd ?? end;
        el.setRangeText(text, from, to, "end");
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
      return;
    case "undo":
    case "redo":
      return;
  }
}

/** Handles Edit menu commands via Monaco's custom event first, then Clipboard API and native selection. */
export function runEditCommand(command: EditCommand, target: Element | null = document.activeElement) {
  if (!window.dispatchEvent(new CustomEvent("oxide-editor-edit", { detail: command, cancelable: true }))) {
    return;
  }
  if (isTextControl(target)) {
    runInputCommand(command, target);
    return;
  }
  const editable = isEditableElement(target) ? target : null;
  switch (command) {
    case "selectAll":
      selectAllInNode(editable ?? document.body);
      return;
    case "copy":
      writeClipboard(window.getSelection()?.toString() ?? "");
      return;
    case "cut": {
      if (!editable) return;
      const selection = window.getSelection();
      const text = selection?.toString() ?? "";
      if (!selection || !text) return;
      writeClipboard(text);
      selection.deleteFromDocument();
      editable.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    case "paste": {
      if (!editable) return;
      readClipboard((text) => {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        range.deleteContents();
        const node = document.createTextNode(text);
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        editable.dispatchEvent(new Event("input", { bubbles: true }));
      });
      return;
    }
    case "undo":
    case "redo":
      return;
  }
}
