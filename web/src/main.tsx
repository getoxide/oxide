import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { highlighter } from "./highlighter";
import { warmModelCatalogs } from "./modelCatalogCache";
import "./fonts.css";
import "./styles.css";
import "./workbench.css";
import "./appearance.css";
import "./interactions.css";
import { applyAppearance } from "./appearance";
applyAppearance();

// Start the highlight worker now so common grammars are compiled before the
// first code block needs them.
highlighter();

// Detect Providers and load their model catalogs now, so the Model picker
// opens already populated.
void warmModelCatalogs();

// The terminal and editor measure glyphs when they mount, so wait for the bundled fonts first.
// A font that fails to load must not hold the app behind the splash.
void Promise.race([
  Promise.allSettled(['13px Inter', '13px "JetBrains Mono"'].map((font) => document.fonts.load(font))),
  new Promise((resolve) => setTimeout(resolve, 2000)),
]).finally(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
