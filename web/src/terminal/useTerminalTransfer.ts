import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

export const OXIDE_FILE_MIME = "application/x-oxide-file-path";

/** Literal paths, never executable shell fragments. PowerShell and POSIX differ on apostrophes. */
export function terminalPaths(paths: string[], windows = /Windows/i.test(navigator.userAgent)): string {
  return paths.map((path) => `'${path.replaceAll("'", windows ? "''" : "'\\''")}'`).join(" ") + " ";
}

function hasFileMime(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes(OXIDE_FILE_MIME);
}

/** Native file drops bypass DOM drop events in Tauri: the dropped paths are typed into the terminal. */
export function useTerminalTransfer(host: RefObject<HTMLElement | null>, visible: boolean, insert: (text: string) => void) {
  const latest = useRef(insert);
  useLayoutEffect(() => { latest.current = insert; });
  const [nativeDragging, setNativeDragging] = useState(false);
  const [domDragging, setDomDragging] = useState(false);

  useEffect(() => {
    if (!visible || !host.current) return;
    const element = host.current;
    let active = true;
    void Promise.resolve().then(() => {
      if (active) {
        setNativeDragging(false);
        setDomDragging(false);
      }
    });
    let unlisten: (() => void) | undefined;
    const over = (position: { x: number; y: number }) => {
      const rect = element.getBoundingClientRect();
      const x = position.x / window.devicePixelRatio, y = position.y / window.devicePixelRatio;
      return rect.width > 0 && rect.height > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    };
    try {
      void getCurrentWebview().onDragDropEvent(({ payload }) => {
        if (!active) return;
        if (payload.type === "leave") setNativeDragging(false);
        else if (payload.type === "drop") {
          setNativeDragging(false);
          if (over(payload.position) && payload.paths.length) latest.current(terminalPaths(payload.paths));
        } else setNativeDragging(over(payload.position));
      }).then((stop) => { if (active) unlisten = stop; else stop(); }).catch(() => {});
    } catch { /* Browser previews have no native drops. */ }

    let dragDepth = 0;
    const onDragEnter = (event: DragEvent) => {
      if (!hasFileMime(event)) return;
      event.preventDefault();
      dragDepth += 1;
      setDomDragging(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!hasFileMime(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      setDomDragging(true);
    };
    const onDragLeave = (event: DragEvent) => {
      if (!hasFileMime(event)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0 || !element.contains(event.relatedTarget as Node | null)) {
        dragDepth = 0;
        setDomDragging(false);
      }
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFileMime(event)) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepth = 0;
      setDomDragging(false);
      const droppedPath = event.dataTransfer?.getData(OXIDE_FILE_MIME);
      if (droppedPath) latest.current(terminalPaths([droppedPath]));
    };

    element.addEventListener("dragenter", onDragEnter);
    element.addEventListener("dragover", onDragOver);
    element.addEventListener("dragleave", onDragLeave);
    element.addEventListener("drop", onDrop);

    return () => {
      active = false;
      unlisten?.();
      element.removeEventListener("dragenter", onDragEnter);
      element.removeEventListener("dragover", onDragOver);
      element.removeEventListener("dragleave", onDragLeave);
      element.removeEventListener("drop", onDrop);
    };
  }, [host, visible]);

  return { dragging: visible && (nativeDragging || domDragging) };
}
