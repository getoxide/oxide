# React for the webview frontend

Oxide's webview frontend is React. A spike that rendered the same streaming transcript in React 19, Solid 1.9 and Svelte 5 inside Tauri found them tied on streaming: about 60 fps with per-frame coalesced deltas, the same ~2-frame latency, and similar webview memory. The only measured gap was jump-scrolling a 10k-message history, where React dropped about a third as many frames. That gap came from a virtualisation adapter rendering scroll updates synchronously, not from React's raw speed, and React's ecosystem is the most mature. Solid and Svelte save about 55 KB gzip, which doesn't matter for a local app. Prototype and numbers: the `prototype/frontend-spike` branch.

## Consequences

- Syntax highlighting is the costliest measured step (first-use Shiki grammar compilation, about 570 ms in the spike), so it runs in a worker, off the main thread.
