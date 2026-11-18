// The only module that talks to Tauri's low-level IPC (`@tauri-apps/api/core` and `/event`);
// ESLint bans those imports everywhere else (web/eslint.config.js).
//
// - Typed commands come from `./bindings` (`commands.*`), generated from the Rust side.
// - `attach_bytes` is the one command that takes a raw request body, which the generator cannot
//   describe, so it has a typed wrapper here: `attachFile`.
// - Events and streams go through `listenTo` and `Channel`, so cleanup is written once.
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Attachment } from "./bindings";

export { Channel };

/** The bytes of a `File`, also where `File.arrayBuffer` is missing (older webviews, jsdom). */
export async function readBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") return new Uint8Array(await file.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

/** Hands a pasted or dropped file to Core as an Attachment. Core validates name, size and type. */
export async function attachFile(file: File): Promise<Attachment> {
  return invoke<Attachment>("attach_bytes", await readBytes(file), {
    headers: { "x-oxide-name": encodeURIComponent(file.name) },
  });
}

/**
 * Listens to a Core event. Returns a cleanup that is safe to call at any time, including before
 * the listener finished registering (a component unmounted straight after mounting). A failure
 * to register is dropped: the Core is unreachable and the caller's own fetch reports that.
 */
export function listenTo<T>(event: string, handler: (payload: T) => void): () => void {
  let stopped = false;
  let stop: (() => void) | undefined;
  void listen<T>(event, (e) => handler(e.payload))
    .then((unlisten) => {
      if (stopped) unlisten();
      else stop = unlisten;
    })
    .catch(() => {});
  return () => {
    stopped = true;
    stop?.();
    stop = undefined;
  };
}
