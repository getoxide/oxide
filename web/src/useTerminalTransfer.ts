import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

/** Literal paths, never executable shell fragments. PowerShell and POSIX differ on apostrophes. */
export function terminalPaths(paths: string[], windows = /Windows/i.test(navigator.userAgent)): string {
  return paths.map((path) => `'${path.replaceAll("'", windows ? "''" : "'\\''")}'`).join(" ") + " ";
}

/** Native file drops bypass DOM drop events in Tauri: the dropped paths are typed into the terminal. */
export function useTerminalTransfer(host: RefObject<HTMLElement | null>, visible: boolean, insert: (text: string) => void) {
  const latest = useRef(insert);
  useLayoutEffect(() => { latest.current = insert; });
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!visible || !host.current) return;
    const element = host.current;
    let active = true;
    void Promise.resolve().then(() => { if (active) setDragging(false); });
    let unlisten: (() => void) | undefined;
    const over = (position: { x: number; y: number }) => {
      const rect = element.getBoundingClientRect();
      const x = position.x / window.devicePixelRatio, y = position.y / window.devicePixelRatio;
      return rect.width > 0 && rect.height > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    };
    try {
      void getCurrentWebview().onDragDropEvent(({ payload }) => {
        if (!active) return;
        if (payload.type === "leave") setDragging(false);
        else if (payload.type === "drop") {
          setDragging(false);
          if (over(payload.position) && payload.paths.length) latest.current(terminalPaths(payload.paths));
        } else setDragging(over(payload.position));
      }).then((stop) => { if (active) unlisten = stop; else stop(); }).catch(() => {});
    } catch { /* Browser previews have no native drops. */ }
    return () => {
      active = false;
      unlisten?.();
    };
  }, [host, visible]);
  return { dragging: visible && dragging };
}
