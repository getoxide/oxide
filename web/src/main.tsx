import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { highlighter } from "./shared/highlighter";
import "./styles/fonts.css";
import "./styles/styles.css";
import "./styles/workbench.css";
import "./styles/appearance.css";
import "./styles/interactions.css";
import { applyAppearance } from "./shared/appearance";
applyAppearance();

// Start the highlight worker now so common grammars are compiled before the
// first code block needs them.
highlighter();

// The terminal and editor measure glyphs when they mount, so wait for the bundled fonts first.
// A font that fails to load must not hold the app behind the splash.
void Promise.race([
  Promise.allSettled(["13px Inter", '13px "JetBrains Mono"'].map((font) => document.fonts.load(font))),
  new Promise((resolve) => setTimeout(resolve, 2000)),
]).finally(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
