import { beforeEach, describe, expect, it, vi } from "vitest";

// A plain function, not `vi.fn`: vitest tracks the promises a mock returns, and a deliberately
// rejected one would be reported as unhandled even though `listenTo` handles it.
let listenImpl: (name: string, callback: (event: { payload: number }) => void) => Promise<() => void>;
vi.mock("@tauri-apps/api/event", () => ({ listen: (...args: Parameters<typeof listenImpl>) => listenImpl(...args) }));
vi.mock("@tauri-apps/api/core", () => ({ Channel: class {}, invoke: vi.fn() }));

import { listenTo } from "./ipc";

const settle = async () => { for (let i = 0; i < 3; i++) await Promise.resolve(); };

beforeEach(() => { listenImpl = () => Promise.resolve(() => {}); });

describe("listenTo", () => {
  it("passes the payload of each event to the handler", async () => {
    let deliver: (event: { payload: number }) => void = () => {};
    listenImpl = (_name, callback) => { deliver = callback; return Promise.resolve(() => {}); };
    const seen: number[] = [];
    listenTo<number>("e", (n) => seen.push(n));
    await settle();
    deliver({ payload: 7 });
    expect(seen).toEqual([7]);
  });

  it("stops a listener that was cleaned up before registration finished", async () => {
    const unlisten = vi.fn();
    listenImpl = () => Promise.resolve(unlisten);
    const stop = listenTo("e", () => {});
    stop(); // The component unmounted before `listen` resolved.
    await settle();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("stops a registered listener when cleaned up", async () => {
    const unlisten = vi.fn();
    listenImpl = () => Promise.resolve(unlisten);
    const stop = listenTo("e", () => {});
    await settle();
    stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("drops a failure to register instead of leaving an unhandled rejection", async () => {
    listenImpl = () => Promise.reject(new Error("no core"));
    const stop = listenTo("e", () => {});
    await settle();
    expect(() => stop()).not.toThrow();
  });
});
