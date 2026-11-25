// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { PullRequestCheck } from "../bindings";
import { Checks } from "./PullRequestChecks";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: Root;

const check = (name: string, state: PullRequestCheck["state"], required = false): PullRequestCheck => ({
  name,
  state,
  url: null,
  required,
});

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(checks: PullRequestCheck[]) {
  act(() => root.render(<Checks checks={checks} onOpen={() => {}} />));
}

const summary = () => host.querySelector(".pr-checks-summary")?.textContent;
const folded = () => host.querySelector(".pr-passed > summary")?.textContent;
const rowState = (name: string) =>
  [...host.querySelectorAll(".pr-check")].find((li) => li.querySelector(".pr-check-name")?.textContent === name)?.querySelector(".pr-check-state")
    ?.textContent;

it("agrees with GitHub on 1 neutral, 1 in progress and 1 successful check", () => {
  render([check("lint", "neutral"), check("rust", "pending", true), check("web", "success", true)]);
  expect(summary()).toBe("1 running · 1 passed · 1 neutral");
  expect(folded()).toBe("1 passed · 1 neutral");
  expect(rowState("lint")).toBe("Neutral");
  expect(rowState("rust")).toBe("Running");
  expect(host.querySelector(".pr-bar")?.getAttribute("aria-label")).toBe("1 running, 1 passed, 1 neutral");
});

it("labels skipped checks apart from passed ones, with a muted bar segment of their own", () => {
  render([check("docs", "skipped"), check("web", "success"), check("audit", "skipped")]);
  expect(summary()).toBe("1 passed · 2 skipped");
  expect(rowState("docs")).toBe("Skipped");
  expect(rowState("web")).toBe("Passed");
  const segments = [...host.querySelectorAll(".pr-bar > i")].map((i) => [i.className, (i as HTMLElement).style.flexGrow]);
  expect(segments).toEqual([
    ["success", "1"],
    ["skipped", "2"],
  ]);
});

it("folds many completed checks under one row that names each outcome", () => {
  render([check("a", "success"), check("b", "success"), check("c", "skipped"), check("d", "neutral")]);
  expect(summary()).toBe("2 passed · 1 neutral · 1 skipped");
  expect(folded()).toBe("All 4 completed: 2 passed · 1 neutral · 1 skipped");
});
