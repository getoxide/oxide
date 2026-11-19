import { readJson, removeKey, storageKeys, writeJson } from "./storage";
import { useCallback, useEffect, useState, type RefObject } from "react";

export type PanelName = "sidebar" | "tools" | "split";

function readSize(name: PanelName): number | null {
  const value = readJson(storageKeys.panelSize(name));
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function usePanelSize(name: PanelName) {
  const [preferred, setPreferred] = useState<number | null>(() => readSize(name));
  const commit = useCallback((value: number) => {
    setPreferred(value);
    writeJson(storageKeys.panelSize(name), value);
  }, [name]);
  const reset = useCallback(() => {
    setPreferred(null);
    removeKey(storageKeys.panelSize(name));
  }, [name]);
  const cancel = useCallback(() => setPreferred(readSize(name)), [name]);
  return { preferred, resize: setPreferred, commit, reset, cancel };
}

export function useElementSize(ref: RefObject<HTMLElement | null>, initial: { width: number; height: number }) {
  const [size, setSize] = useState(initial);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((previous) => previous.width === width && previous.height === height ? previous : { width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}
