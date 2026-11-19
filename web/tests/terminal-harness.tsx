// Browser-only IPC adapter: all shell commands/output/resize events use the real Rust PTY.
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { TerminalWorkbench } from "../src/terminal/TerminalWorkbench";
import "../src/styles/styles.css";
import "../src/styles/workbench.css";
import "../src/styles/appearance.css";
import "../src/styles/interactions.css";
import { applyAppearance } from "../src/shared/appearance";
import { Skeleton } from "../src/shared/Skeleton";
applyAppearance();
declare global {
  interface Window {
    nativeTerminal: (cmd: string, args: object) => Promise<unknown>;
    nativeOutput: (bytes: number[]) => void;
    terminalRoot: string;
  }
}
let callback: number;
let index = 0;
mockIPC(async (cmd, args) => {
  const params = (args ?? {}) as Record<string, unknown>;
  if (cmd === "start_block_terminal") {
    callback =
      typeof params.onOutput === "object"
        ? (params.onOutput as { id: number }).id
        : Number(String(params.onOutput).split(":")[1]);
  }
  return await window.nativeTerminal(cmd, args!);
});
window.nativeOutput = (bytes) => {
  (
    window as unknown as {
      __TAURI_INTERNALS__: {
        runCallback: (id: number, value: unknown) => void;
      };
    }
  ).__TAURI_INTERNALS__.runCallback(callback, {
    message: bytes,
    index: index++,
  });
};
createRoot(document.getElementById("root")!).render(
  <div style={{ height: "100vh", display: "flex" }}>
    {location.search.includes("loading") ? (
      <Skeleton kind="code" label="Loading Terminal…" />
    ) : (
      <TerminalWorkbench
        projectId={1}
        rootPath={window.terminalRoot}
        contextKey="native-repro"
        visible
      />
    )}
  </div>,
);
