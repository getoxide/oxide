import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { subscribeFileDrag } from "./fileDrag";

/** Literal paths, never executable shell fragments. PowerShell and POSIX differ on apostrophes. */
export function terminalPaths(paths: string[], windows = /Windows/i.test(navigator.userAgent)): string {
  return paths.map((path) => `'${path.replaceAll("'", windows ? "''" : "'\\''")}'`).join(" ") + " ";
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
    const overClient = (x: number, y: number) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    };
    const over = (position: { x: number; y: number }) =>
      overClient(position.x / window.devicePixelRatio, position.y / window.devicePixelRatio);
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

    const stopFileDrag = subscribeFileDrag((event) => {
      if (!active) return;
      if (event.type === "move") {
        setDomDragging(overClient(event.drag.x, event.drag.y));
      } else if (event.type === "drop") {
        setDomDragging(false);
        if (overClient(event.drag.x, event.drag.y)) {
          latest.current(terminalPaths([event.drag.path]));
        }
      } else {
        setDomDragging(false);
      }
    });

    return () => {
      active = false;
      unlisten?.();
      stopFileDrag();
    };
  }, [host, visible]);

  return { dragging: visible && (nativeDragging || domDragging) };
}
