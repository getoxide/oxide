// The only module that talks to Tauri's low-level IPC (`@tauri-apps/api/core` and `/event`);
// ESLint bans those imports everywhere else (web/eslint.config.js).
//
// - Typed commands come from `./bindings` (`commands.*`), generated from the Rust side.
// - Events and streams go through `listenTo` and `Channel`, so cleanup is written once.
import { Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export { Channel };

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
