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
  expect(summary()).toBe("1 neutral · 1 running · 1 passed");
  expect(folded()).toBe("1 neutral · 1 passed");
  expect(rowState("lint")).toBe("Neutral");
  expect(rowState("rust")).toBe("Running");
  expect(host.querySelector(".pr-bar")?.getAttribute("aria-label")).toBe("1 neutral, 1 running, 1 passed");
});

it("labels skipped checks apart from passed ones, with a muted bar segment of their own", () => {
  render([check("docs", "skipped"), check("web", "success"), check("audit", "skipped")]);
  expect(summary()).toBe("2 skipped · 1 passed");
  expect(rowState("docs")).toBe("Skipped");
  expect(rowState("web")).toBe("Passed");
  const segments = [...host.querySelectorAll(".pr-bar > i")].map((i) => [i.className, (i as HTMLElement).style.flexGrow]);
  expect(segments).toEqual([
    ["skipped", "2"],
    ["success", "1"],
  ]);
});

it("folds many completed checks under one row that names each outcome", () => {
  render([check("a", "success"), check("b", "success"), check("c", "skipped"), check("d", "neutral")]);
  expect(summary()).toBe("1 neutral · 1 skipped · 2 passed");
  expect(folded()).toBe("All 4 completed: 1 neutral · 1 skipped · 2 passed");
});

it("marks the folded row green only when every folded check passed", () => {
  const icon = () => host.querySelector(".pr-passed > summary svg")?.getAttribute("class") ?? "";
  render([check("a", "success"), check("b", "success"), check("c", "success"), check("d", "success")]);
  expect(icon()).toContain("pr-check-success");

  render([check("a", "success"), check("b", "success"), check("c", "skipped"), check("d", "neutral")]);
  expect(icon()).not.toContain("pr-check-success");
  expect(icon()).toContain("pr-check-neutral");
});

it("keeps failing checks first in the header", () => {
  render([check("a", "success"), check("b", "failure"), check("c", "neutral"), check("d", "pending")]);
  expect(summary()).toBe("1 failing · 1 neutral · 1 running · 1 passed");
});
