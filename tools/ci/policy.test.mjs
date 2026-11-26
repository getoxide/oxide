import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  bumpVersion, checkPrTitle, checkPrerelease, checkReleaseVersion, checkTauriAlignment, commandLine, dependabotDecision, evaluateGate, lanesFor,
  ADVISORY_SCANS, downloadsSection, localPlan, previousReleaseTag, releaseNotes,
  INSTALLERS, UPDATER_PLATFORMS, buildUpdateFeed, checkPublishedFeeds, checkUpdaterSignature, feedUrls, isUpdaterOnlyAsset, missingSecrets, prereleaseFeedUrl, releaseChecksums,
  APT_REPOSITORY_FILES, REPOSITORY_KEY_FILES, REPOSITORY_SECRETS, aptReleaseFile, checkAptRepository, checkDnfRepository, dnfRepoFile, aptSourceFile, APT_KEYRING_PATH, APT_SOURCE_PATH, DNF_REPO_PATH, isRepositoryAsset, missingPresent, repositoryPlan,
} from "./policy.mjs";

const ALL_ON = { web: true, rust: true, bundle: true, supplyChain: true, automation: true };
const ALL_OFF = { web: false, rust: false, bundle: false, supplyChain: false, automation: false };

describe("lanesFor", () => {
  test("a docs-only change turns every lane off", () => {
    assert.deepEqual(lanesFor(["docs/workbench.md", "README.md", "assets/README.md", "GLOSSARY.md"], "pull_request"), ALL_OFF);
  });

  test("repository metadata files turn every lane off", () => {
    assert.deepEqual(lanesFor(["CITATION.cff", "llms.txt"], "pull_request"), ALL_OFF);
  });

  test("a web-only change turns on web only", () => {
    assert.deepEqual(lanesFor(["web/src/App.tsx", "web/src/App.test.tsx"], "pull_request"), { ...ALL_OFF, web: true });
  });

  test("a Tauri config change turns on bundle and rust", () => {
    assert.deepEqual(lanesFor(["crates/oxide-app/tauri.conf.json"], "pull_request"), { ...ALL_OFF, rust: true, bundle: true });
    assert.deepEqual(lanesFor(["crates/oxide-app/icons-dev/icon.png"], "pull_request"), { ...ALL_OFF, rust: true, bundle: true });
    assert.deepEqual(lanesFor(["crates/oxide-app/tauri.dev.conf.json"], "pull_request"), { ...ALL_OFF, rust: true, bundle: true });
  });

  test("the Linux maintainer scripts and the shipped repository key run the bundle and their tests", () => {
    for (const path of ["crates/oxide-app/linux/deb/postinst", "crates/oxide-app/linux/rpm/preun.sh", "crates/oxide-app/linux/repository/oxide-repository.gpg"]) {
      assert.deepEqual(lanesFor([path], "pull_request"), { ...ALL_OFF, rust: true, bundle: true, automation: true }, path);
    }
  });

  test("a bundled licence file under docs turns on bundle", () => {
    assert.deepEqual(lanesFor(["docs/licenses/inter.txt"], "pull_request"), { ...ALL_OFF, bundle: true });
  });

  test("a lockfile change turns on supplyChain and bundle", () => {
    assert.deepEqual(lanesFor(["Cargo.lock"], "pull_request"), { ...ALL_OFF, rust: true, supplyChain: true, bundle: true });
    assert.deepEqual(lanesFor(["web/pnpm-lock.yaml"], "pull_request"), { ...ALL_OFF, web: true, supplyChain: true, bundle: true });
  });

  test("a change to the shared Rust setup turns on rust and automation", () => {
    assert.deepEqual(lanesFor([".github/actions/setup-rust/action.yml"], "pull_request"), { ...ALL_OFF, rust: true, bundle: true, automation: true });
  });

  test("a workflow change turns on automation, and bundle if it is the build workflow", () => {
    assert.deepEqual(lanesFor([".github/workflows/ci.yml"], "pull_request"), { ...ALL_OFF, automation: true });
    assert.deepEqual(lanesFor([".github/workflows/build.yml"], "pull_request"), { ...ALL_OFF, automation: true, bundle: true });
  });

  test("an unknown top-level path turns every lane on", () => {
    assert.deepEqual(lanesFor(["docs/workbench.md", "Makefile"], "pull_request"), ALL_ON);
  });

  test("an empty, missing or truncated list turns every lane on", () => {
    assert.deepEqual(lanesFor([], "pull_request"), ALL_ON);
    assert.deepEqual(lanesFor(undefined, "pull_request"), ALL_ON);
    assert.deepEqual(lanesFor(["docs/a.md"], "pull_request", { total: 4000 }), ALL_ON);
  });

  test("push, schedule and dispatch events turn every lane on", () => {
    for (const event of ["push", "schedule", "workflow_dispatch"]) {
      assert.deepEqual(lanesFor(["docs/workbench.md"], event), ALL_ON);
    }
  });
});

describe("evaluateGate", () => {
  const passing = {
    changes: "success", web: "success", "rust-fmt": "success", rust: "success", "supply-chain": "success",
    automation: "success", "pr-title": "success", bundle: "success",
  };

  test("all jobs succeeding passes", () => {
    assert.equal(evaluateGate(passing, ALL_ON, "pull_request").ok, true);
  });

  test("a failed or cancelled job fails, naming the job", () => {
    const failed = evaluateGate({ ...passing, rust: "failure" }, ALL_ON, "pull_request");
    assert.equal(failed.ok, false);
    assert.match(failed.message, /rust/);
    const cancelled = evaluateGate({ ...passing, bundle: "cancelled" }, ALL_ON, "pull_request");
    assert.equal(cancelled.ok, false);
    assert.match(cancelled.message, /bundle.*cancelled/);
  });

  test("a job skipped because its lane was off passes", () => {
    const docsOnly = { ...passing, web: "skipped", "rust-fmt": "skipped", rust: "skipped", "supply-chain": "skipped", automation: "skipped", bundle: "skipped" };
    assert.equal(evaluateGate(docsOnly, ALL_OFF, "pull_request").ok, true);
  });

  test("a job skipped although its lane was on fails", () => {
    const result = evaluateGate({ ...passing, rust: "skipped" }, { ...ALL_OFF, rust: true }, "pull_request");
    assert.equal(result.ok, false);
    assert.match(result.message, /rust/);
  });

  test("pr-title skipped on push passes, but not on a pull request", () => {
    assert.equal(evaluateGate({ ...passing, "pr-title": "skipped" }, ALL_ON, "push").ok, true);
    assert.equal(evaluateGate({ ...passing, "pr-title": "skipped" }, ALL_ON, "pull_request").ok, false);
  });

  test("a skipped job that no lane accounts for fails", () => {
    assert.equal(evaluateGate({ ...passing, changes: "skipped" }, ALL_OFF, "pull_request").ok, false);
    assert.equal(evaluateGate({ ...passing, "new-job": "skipped" }, ALL_OFF, "pull_request").ok, false);
  });

  test("reads lanes written as step outputs, where only \"false\" turns a lane off", () => {
    assert.equal(evaluateGate({ ...passing, rust: "skipped" }, { rust: "false" }, "pull_request").ok, true);
    assert.equal(evaluateGate({ ...passing, rust: "skipped" }, { rust: "true" }, "pull_request").ok, false);
    assert.equal(evaluateGate({ ...passing, rust: "skipped" }, {}, "pull_request").ok, false);
  });

  test("accepts the shape of the workflow's needs context", () => {
    const needs = Object.fromEntries(Object.entries(passing).map(([job, result]) => [job, { result, outputs: {} }]));
    assert.equal(evaluateGate(needs, ALL_ON, "pull_request").ok, true);
    assert.equal(evaluateGate({ ...needs, web: { result: "failure" } }, ALL_ON, "pull_request").ok, false);
  });

  test("no results fails", () => {
    assert.equal(evaluateGate({}, ALL_ON, "pull_request").ok, false);
    assert.equal(evaluateGate(undefined, ALL_ON, "pull_request").ok, false);
  });
});

describe("checkPrTitle", () => {
  test("allowed types pass with and without scope, and with the breaking marker", () => {
    for (const title of [
      "feat(terminal): render Markdown in command blocks",
      "fix: terminal input on Windows",
      "research: compare terminal emulators",
      "chore(deps): bump serde from 1.0.1 to 1.0.2",
      "refactor(core)!: rename the Project API",
      "feat!: drop the legacy settings file",
      "ci: add the gate check",
    ]) {
      assert.equal(checkPrTitle(title).ok, true, title);
    }
  });

  test("non-conventional titles fail, listing the allowed types", () => {
    for (const title of [".github modified", "fix windows agy", "feature(chat): unknown type", "fix(core) missing colon", "fix(): empty scope", "fix: ", "Feat: capitalised type"]) {
      const result = checkPrTitle(title);
      assert.equal(result.ok, false, title);
      assert.match(result.message, /feat, fix, docs, chore, refactor, test, research, perf, build, ci, revert/);
    }
  });
});

const manifests = (cargo, tauri, web) => ({
  cargoToml: `[workspace]\nmembers = ["crates/oxide-core"]\n\n[workspace.package]\nversion = "${cargo}"\nedition = "2024"\n\n[profile.dev]\ndebug = "line-tables-only"\n`,
  tauriConf: `{\n  "productName": "Oxide",\n  "version": "${tauri}",\n  "identifier": "dev.oxide.app"\n}\n`,
  webPackage: `{\n  "name": "oxide-web",\n  "version": "${web}",\n  "dependencies": { "react": "^19.3.1" }\n}\n`,
});

describe("checkPrerelease", () => {
  test("a stable tag must not be marked pre-release, and an -rc tag must be", () => {
    assert.equal(checkPrerelease({ tag: "v0.1.0", prerelease: false }).ok, true);
    assert.equal(checkPrerelease({ tag: "v0.1.0-rc.1", prerelease: true }).ok, true);
  });

  test("a disagreement fails and says which way and how to fix it", () => {
    const stableMarked = checkPrerelease({ tag: "v0.0.5", prerelease: true });
    assert.equal(stableMarked.ok, false);
    assert.match(stableMarked.message, /v0\.0\.5/);
    assert.match(stableMarked.message, /pre-release/);
    assert.equal(checkPrerelease({ tag: "v0.1.0-rc.1", prerelease: false }).ok, false);
  });

  test("the flag arrives as the string the workflow expression produces", () => {
    assert.equal(checkPrerelease({ tag: "v0.1.0", prerelease: "false" }).ok, true);
    assert.equal(checkPrerelease({ tag: "v0.1.0", prerelease: "true" }).ok, false);
    assert.equal(checkPrerelease({ tag: "v0.1.0-rc.1", prerelease: "true" }).ok, true);
    assert.equal(checkPrerelease({ tag: "v0.1.0", prerelease: "" }).ok, false, "an unknown flag is refused");
  });
});

describe("checkReleaseVersion", () => {
  test("a tag matching all three manifests passes", () => {
    assert.equal(checkReleaseVersion({ tag: "v0.2.0", ...manifests("0.2.0", "0.2.0", "0.2.0") }).ok, true);
  });

  test("each mismatch names the file and its version", () => {
    const result = checkReleaseVersion({ tag: "v0.2.0", ...manifests("0.2.0", "0.1.0", "0.1.9") });
    assert.equal(result.ok, false);
    assert.match(result.message, /tauri\.conf\.json 0\.1\.0/);
    assert.match(result.message, /web\/package\.json 0\.1\.9/);
    assert.doesNotMatch(result.message, /Cargo\.toml/);
    assert.match(checkReleaseVersion({ tag: "v0.2.0", ...manifests("0.1.5", "0.2.0", "0.2.0") }).message, /Cargo\.toml 0\.1\.5/);
  });

  test("a malformed tag fails", () => {
    for (const tag of ["0.2.0", "v0.2", "release-0.2.0", "v0.2.0 ", "v0.2.0-beta", "v0.2.0-rc"]) {
      const result = checkReleaseVersion({ tag, ...manifests("0.2.0", "0.2.0", "0.2.0") });
      assert.equal(result.ok, false, tag);
      assert.match(result.message, /vX\.Y\.Z/);
    }
  });

  test("a release-candidate suffix is accepted", () => {
    assert.equal(checkReleaseVersion({ tag: "v0.2.0-rc.1", ...manifests("0.2.0-rc.1", "0.2.0-rc.1", "0.2.0-rc.1") }).ok, true);
  });

  test("an unreadable manifest fails instead of throwing", () => {
    const result = checkReleaseVersion({ tag: "v0.2.0", ...manifests("0.2.0", "0.2.0", "0.2.0"), tauriConf: "{ not json" });
    assert.equal(result.ok, false);
    assert.match(result.message, /tauri\.conf\.json/);
  });
});

describe("bumpVersion", () => {
  const cargoLock = [
    "version = 4", "",
    "[[package]]", 'name = "oxide-core"', 'version = "0.1.0"', "dependencies = [", ' "serde",', "]", "",
    "[[package]]", 'name = "serde"', 'version = "0.1.0"', 'source = "registry+https://github.com/rust-lang/crates.io-index"', "",
  ].join("\n");

  test("writes the version to all three manifests and the workspace entries of Cargo.lock", () => {
    const bumped = bumpVersion({ ...manifests("0.1.0", "0.1.0", "0.1.0"), cargoLock }, "0.2.0", { members: ["oxide-core"] });
    assert.equal(checkReleaseVersion({ tag: "v0.2.0", ...bumped }).ok, true);
    assert.match(bumped.cargoLock, /name = "oxide-core"\nversion = "0\.2\.0"/);
    assert.match(bumped.cargoLock, /name = "serde"\nversion = "0\.1\.0"/);
    assert.match(bumped.cargoToml, /\[profile\.dev\]\ndebug = "line-tables-only"/);
    assert.match(bumped.webPackage, /"react": "\^19\.3\.1"/);
  });

  test("accepts a leading v and a release-candidate suffix", () => {
    const bumped = bumpVersion({ ...manifests("0.1.0", "0.1.0", "0.1.0"), cargoLock }, "v0.2.0-rc.1", { members: ["oxide-core"] });
    assert.equal(checkReleaseVersion({ tag: "v0.2.0-rc.1", ...bumped }).ok, true);
  });

  test("refuses a version that is not X.Y.Z or a release candidate", () => {
    for (const version of ["0.2", "0.2.0-beta"]) {
      assert.throws(() => bumpVersion({ ...manifests("0.1.0", "0.1.0", "0.1.0"), cargoLock }, version, { members: ["oxide-core"] }), /X\.Y\.Z/);
    }
  });

  test("refuses a workspace member missing from Cargo.lock", () => {
    assert.throws(() => bumpVersion({ ...manifests("0.1.0", "0.1.0", "0.1.0"), cargoLock }, "0.2.0", { members: ["oxide-app"] }), /oxide-app/);
  });
});

describe("checkTauriAlignment", () => {
  const cargoLock = (tauri) => `[[package]]\nname = "tauri"\nversion = "${tauri}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n\n[[package]]\nname = "tauri-build"\nversion = "9.9.9"\n`;
  const pnpmLock = (api, cli) => [
    "lockfileVersion: '9.0'", "", "importers:", "", "  .:", "    dependencies:",
    ...(api ? ["      '@tauri-apps/api':", `        specifier: ^${api}`, `        version: ${api}`] : []),
    "    devDependencies:",
    ...(cli ? ["      '@tauri-apps/cli':", `        specifier: ^${cli}`, `        version: ${cli}`] : []),
    "",
  ].join("\n");

  test("the same major.minor passes", () => {
    assert.equal(checkTauriAlignment({ cargoLock: cargoLock("2.12.5"), pnpmLock: pnpmLock("2.12.4", "2.12.0") }).ok, true);
  });

  test("Windows line endings are read the same way", () => {
    const crlf = (text) => text.replace(/\n/g, "\r\n");
    assert.equal(checkTauriAlignment({ cargoLock: crlf(cargoLock("2.12.5")), pnpmLock: crlf(pnpmLock("2.12.4", "2.12.0")) }).ok, true);
  });

  test("drift names the package and both versions", () => {
    const result = checkTauriAlignment({ cargoLock: cargoLock("2.13.0"), pnpmLock: pnpmLock("2.12.4", "2.13.1") });
    assert.equal(result.ok, false);
    assert.match(result.message, /@tauri-apps\/api 2\.12\.4/);
    assert.match(result.message, /2\.13\.0/);
    assert.doesNotMatch(result.message, /@tauri-apps\/cli/);
  });

  test("a missing package fails", () => {
    const noCli = checkTauriAlignment({ cargoLock: cargoLock("2.12.5"), pnpmLock: pnpmLock("2.12.4") });
    assert.equal(noCli.ok, false);
    assert.match(noCli.message, /@tauri-apps\/cli/);
    const noCrate = checkTauriAlignment({ cargoLock: "", pnpmLock: pnpmLock("2.12.4", "2.12.4") });
    assert.equal(noCrate.ok, false);
    assert.match(noCrate.message, /tauri crate/);
  });
});

describe("releaseNotes", () => {
  const identity = { repository: "cavallinilorenzo/oxide", previousTag: "v0.1.0", tag: "v0.2.0" };
  // The lines under one `### <heading>` of the notes.
  const section = (notes, heading) =>
    notes.split(`### ${heading}\n`)[1]?.split("\n###")[0].split("\n").filter((line) => line.startsWith("- ")) ?? [];

  test("types map to sections, and breaking changes and dependency bumps get their own", () => {
    const notes = releaseNotes([
      { subject: "feat(terminal): render Markdown in command blocks (#215)" },
      { subject: "fix(workbench): terminal input (#218)" },
      { subject: "docs: explain Project palette (#230)" },
      { subject: "chore(deps): bump serde from 1.0.1 to 1.0.2 (#231)" },
      { subject: "chore(deps-dev): bump vitest (#232)" },
      { subject: "refactor(core)!: rename the Project API (#233)" },
      { subject: "feat(settings): new storage (#234)", body: "BREAKING CHANGE: old settings are not migrated." },
    ], identity);
    assert.deepEqual(section(notes, "Breaking changes"), [
      "- **core:** rename the Project API ([#233](https://github.com/cavallinilorenzo/oxide/pull/233))",
      "- **settings:** new storage ([#234](https://github.com/cavallinilorenzo/oxide/pull/234))",
    ]);
    assert.deepEqual(section(notes, "Features"), ["- **terminal:** render Markdown in command blocks ([#215](https://github.com/cavallinilorenzo/oxide/pull/215))"]);
    assert.deepEqual(section(notes, "Fixes"), ["- **workbench:** terminal input ([#218](https://github.com/cavallinilorenzo/oxide/pull/218))"]);
    assert.deepEqual(section(notes, "Documentation"), ["- explain Project palette ([#230](https://github.com/cavallinilorenzo/oxide/pull/230))"]);
    assert.equal(section(notes, "Dependencies").length, 2);
    assert.ok(notes.indexOf("### Breaking changes") < notes.indexOf("### Features"));
    assert.match(notes, /compare\/v0\.1\.0\.\.\.v0\.2\.0/);
  });

  test("release bumps are omitted and other titles go to Other, with PR links", () => {
    const notes = releaseNotes([
      { subject: "chore(release): v0.2.0 (#240)" },
      { subject: ".github modified (#223)" },
      { subject: "ci: add the gate check (#237)" },
    ], identity);
    assert.doesNotMatch(notes, /chore\(release\)|v0\.2\.0 \(/);
    assert.deepEqual(section(notes, "Other"), [
      "- .github modified ([#223](https://github.com/cavallinilorenzo/oxide/pull/223))",
      "- ci: add the gate check ([#237](https://github.com/cavallinilorenzo/oxide/pull/237))",
    ]);
    assert.equal(section(notes, "Features").length, 0);
  });

  test("an empty range says so explicitly", () => {
    for (const commits of [[], [{ subject: "chore(release): v0.2.0 (#240)" }]]) {
      assert.match(releaseNotes(commits, identity), /No changes since v0\.1\.0\./);
    }
    assert.match(releaseNotes([], { ...identity, previousTag: undefined }), /No changes\./);
  });

  test("a stable release is compared with the previous stable tag, a candidate with any earlier tag", () => {
    const earlier = ["v0.2.0-rc.2", "v0.2.0-rc.1", "v0.1.1", "v0.1.0"];
    assert.equal(previousReleaseTag("v0.2.0", earlier), "v0.1.1");
    assert.equal(previousReleaseTag("v0.2.0-rc.3", earlier), "v0.2.0-rc.2");
    assert.equal(previousReleaseTag("v0.1.0", []), undefined);
  });

  test("the first release links to the tag's history instead of a comparison", () => {
    assert.match(releaseNotes([{ subject: "feat: first" }], { ...identity, previousTag: undefined }), /commits\/v0\.2\.0/);
  });
});

describe("dependabotDecision", () => {
  const update = (updateType, prevVersion, newVersion, extra = {}) =>
    ({ dependencyName: "serde", updateType: `version-update:semver-${updateType}`, prevVersion, newVersion, ...extra });

  test("a patch merges automatically, but a 0.0.x patch needs review", () => {
    assert.equal(dependabotDecision([update("patch", "1.0.1", "1.0.2")]).decision, "auto");
    assert.equal(dependabotDecision([update("patch", "0.4.1", "0.4.2")]).decision, "auto");
    const result = dependabotDecision([update("patch", "0.0.3", "0.0.4")]);
    assert.equal(result.decision, "manual");
    assert.match(result.reason, /serde 0\.0\.3/);
  });

  test("a 1.x minor merges automatically, a 0.x minor needs review", () => {
    assert.equal(dependabotDecision([update("minor", "1.2.0", "1.3.0")]).decision, "auto");
    assert.equal(dependabotDecision([update("minor", "v0.11.0", "v0.12.0")]).decision, "manual");
  });

  test("majors and the tauri and specta groups need review", () => {
    assert.equal(dependabotDecision([update("major", "1.0.0", "2.0.0")]).decision, "manual");
    for (const dependencyGroup of ["tauri", "specta"]) {
      const result = dependabotDecision([update("patch", "2.12.4", "2.12.5", { dependencyGroup })]);
      assert.equal(result.decision, "manual");
      assert.match(result.reason, new RegExp(dependencyGroup));
    }
  });

  test("a mixed group with any manual member needs review", () => {
    const result = dependabotDecision([update("patch", "1.0.1", "1.0.2"), update("major", "4.0.0", "5.0.0", { dependencyName: "vite" })]);
    assert.equal(result.decision, "manual");
    assert.match(result.reason, /vite/);
  });

  test("an unknown update type or unreadable versions need review", () => {
    assert.equal(dependabotDecision([{ dependencyName: "serde", updateType: "", prevVersion: "1.0.0", newVersion: "1.0.1" }]).decision, "manual");
    assert.equal(dependabotDecision([update("patch", "abc1234", "def5678")]).decision, "manual");
    assert.equal(dependabotDecision([update("minor", undefined, "1.3.0")]).decision, "manual");
  });

  test("an empty or unreadable list needs review", () => {
    assert.equal(dependabotDecision([]).decision, "manual");
    assert.equal(dependabotDecision(undefined).decision, "manual");
  });
});

describe("localPlan", () => {
  const lines = (plan) => plan.run.map(({ command }) => commandLine(command));
  const CLIPPY = "cargo clippy --locked --workspace --all-targets -- -D warnings";
  const NEXTEST = "cargo nextest run --locked --workspace";

  test("Windows runs both Rust checks and its own bundle, and skips the macOS bundle with a reason", () => {
    const plan = localPlan("win32");
    assert.ok(lines(plan).includes(CLIPPY));
    assert.ok(lines(plan).includes(NEXTEST));
    assert.ok(lines(plan).some((line) => line.startsWith("web/node_modules/.bin/tauri.cmd build --ci --bundles nsis")));
    assert.match(plan.skipped.find(({ id }) => id === "bundle-macos")?.reason ?? "", /macOS/);
  });

  test("macOS runs both Rust checks and its own bundle, and skips the Windows bundle", () => {
    const plan = localPlan("darwin");
    assert.ok(lines(plan).includes(CLIPPY));
    assert.ok(lines(plan).includes("web/node_modules/.bin/tauri build --ci --bundles app,dmg"));
    assert.ok(plan.skipped.some(({ id }) => id === "bundle-windows"));
  });

  test("Windows runs its own bundle, and skips the macOS bundle", () => {
    const plan = localPlan("win32");
    assert.ok(lines(plan).includes("web/node_modules/.bin/tauri.cmd build --ci --bundles nsis"));
    assert.ok(plan.skipped.some(({ id }) => id === "bundle-macos"));
  });

  test("Linux runs both Rust checks and its own bundle, and skips the macOS and Windows bundles", () => {
    const plan = localPlan("linux");
    assert.ok(lines(plan).includes(CLIPPY));
    assert.ok(lines(plan).includes(NEXTEST));
    assert.ok(lines(plan).includes("web/node_modules/.bin/tauri build --ci --bundles appimage,deb,rpm"));
    assert.deepEqual(plan.skipped.filter(({ id }) => ["bundle-macos", "bundle-windows"].includes(id)).length, 2);
  });

  test("macOS and Windows skip the Linux bundle", () => {
    for (const platform of ["darwin", "win32"]) assert.ok(localPlan(platform).skipped.some(({ id }) => id === "bundle-linux"), platform);
  });

  test("the full tier runs the tooling suite and reports CI-only checks as skipped", () => {
    const plan = localPlan("darwin");
    assert.ok(lines(plan).includes('node --test "tools/**/*.test.mjs"'));
    for (const id of ["cargo-deny", "actionlint", "zizmor", "pr-title"]) assert.ok(plan.skipped.some((entry) => entry.id === id), id);
    for (const { reason } of plan.skipped) assert.ok(reason.length > 0);
  });

  test("fast has only rustfmt, the two text checks, ESLint and TypeScript, on every platform", () => {
    for (const platform of ["darwin", "win32", "linux"]) {
      assert.deepEqual(lines(localPlan(platform, "fast")), [
        "cargo fmt --all --check", "node tools/checks/process-builders.mjs", "node tools/checks/platform-layer.mjs", "pnpm --dir web lint", "pnpm --dir web typecheck",
      ]);
    }
  });

  test("the full tier checks that OS-specific code stays in the platform layer", () => {
    for (const platform of ["darwin", "win32", "linux"]) assert.ok(lines(localPlan(platform)).includes("node tools/checks/platform-layer.mjs"), platform);
  });

  test("the windows tier cross-compiles and lints for Windows on macOS and Linux only", () => {
    for (const platform of ["darwin", "linux"]) {
      const [line] = lines(localPlan(platform, "windows"));
      assert.match(line, /^cargo xwin clippy --locked --target x86_64-pc-windows-msvc --workspace /);
      assert.match(line, /--all-targets -- -D warnings$/);
    }
    const onWindows = localPlan("win32", "windows");
    assert.deepEqual(onWindows.run, []);
    assert.match(onWindows.skipped[0].reason, /macOS and Linux/);
  });

  test("the full tier checks that Git and gh start only in the hardened builders", () => {
    for (const platform of ["darwin", "win32", "linux"]) assert.ok(lines(localPlan(platform)).includes("node tools/checks/process-builders.mjs"), platform);
  });

  test("an unknown platform or tier fails", () => {
    assert.throws(() => localPlan("aix"), /platform/);
    assert.throws(() => localPlan("toString"), /platform/);
    assert.throws(() => localPlan("darwin", "slow"), /tier/);
  });

  // The one parity test: green locally must mean the same commands as CI.
  const workflowDir = fileURLToPath(new URL("../../.github/workflows/", import.meta.url));
  const workflows = readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name)).map((name) => readFileSync(join(workflowDir, name), "utf8"));
  test("every local command appears verbatim in a CI workflow", () => {
    for (const platform of ["darwin", "win32", "linux"]) {
      // The bundle jobs call the shared build workflow, which lands in CI/CD slice 3 (#238).
      const checks = localPlan(platform).run.filter(({ id }) => !id.startsWith("bundle-") || existsSync(join(workflowDir, "build.yml")));
      for (const line of lines({ run: checks })) {
        assert.ok(workflows.some((workflow) => workflow.includes(line)), `${line} is not in .github/workflows/`);
      }
    }
  });
});


describe("downloadsSection", () => {
  test("names the platform of every installer, not just its architecture", () => {
    const section = downloadsSection([
      "Oxide.dmg", "Oxide-x64.exe", "Oxide-arm64.exe",
      "Oxide-x64.AppImage", "Oxide-x64.deb", "Oxide-x64.rpm", "notes.txt",
    ]);
    assert.match(section, /\| macOS \(Apple Silicon\) \| Disk image \| `Oxide\.dmg` \|/);
    assert.match(section, /\| Windows \(Intel\/AMD, 64-bit\) \| Installer \| `Oxide-x64\.exe` \|/);
    assert.match(section, /\| Windows \(Arm\) \|/);
    assert.match(section, /\| Linux \(Intel\/AMD, 64-bit\): Debian, Ubuntu \|/);
    assert.match(section, /Fedora, RHEL, openSUSE/);
    assert.doesNotMatch(section, /notes\.txt/);
  });

  test("is empty when there is no installer", () => {
    assert.equal(downloadsSection(["notes.txt"]), "");
  });

  test("every installer has a short name with no version, so releases/latest/download/<name> always serves the newest", () => {
    assert.deepEqual(INSTALLERS.map(({ name }) => name), [
      "Oxide.dmg", "Oxide-x64.exe", "Oxide-arm64.exe",
      "Oxide-x64.AppImage", "Oxide-arm64.AppImage", "Oxide-x64.deb", "Oxide-arm64.deb", "Oxide-x64.rpm", "Oxide-arm64.rpm",
    ]);
    const section = downloadsSection(INSTALLERS.map(({ name }) => name).reverse());
    assert.equal(section.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| Platform") && !line.startsWith("| ---")).length, INSTALLERS.length);
    assert.ok(section.indexOf("Oxide.dmg") < section.indexOf("Oxide-x64.exe"), "rows follow the platform order, not the input order");
  });

  test("an old versioned name is not an installer", () => {
    assert.equal(downloadsSection(["Oxide_0.0.4_aarch64.dmg", "Oxide_1.0.0_windows_x64.exe"]), "");
  });
});

describe("ADVISORY_SCANS", () => {
  const read = (name) => readFileSync(fileURLToPath(new URL(`../../.github/workflows/${name}`, import.meta.url)), "utf8");
  const needs = (workflow, job) => {
    const block = workflow.split(/^ {2}(?=[a-z][\w-]*:$)/m).find((part) => part.startsWith(`${job}:`)) ?? "";
    return block.match(/^ {4}needs: (.+)$/m)?.[1] ?? "";
  };

  test("covers both Rust and JavaScript, at the severity the release refuses", () => {
    assert.deepEqual(ADVISORY_SCANS.map(({ id }) => id), ["cargo-deny-advisories", "pnpm-audit"]);
    assert.ok(ADVISORY_SCANS.some(({ command }) => commandLine(command) === "pnpm --dir web audit --prod --audit-level high"));
    assert.ok(ADVISORY_SCANS.some(({ command }) => commandLine(command) === "cargo deny --locked check advisories"));
  });

  test("the daily workflow and the release workflow run every scan", () => {
    for (const name of ["advisories.yml", "release.yml"]) {
      const workflow = read(name);
      for (const { command } of ADVISORY_SCANS) assert.ok(workflow.includes(commandLine(command)), `${commandLine(command)} is not in ${name}`);
    }
  });

  test("a release cannot build until both scans pass", () => {
    const release = read("release.yml");
    const build = needs(release, "build");
    assert.match(build, /verify/);
    for (const job of ["audit-rust", "audit-js"]) {
      assert.match(release, new RegExp(`^ {2}${job}:$`, "m"));
      assert.match(build, new RegExp(job));
    }
  });

  test("the daily workflow tracks JavaScript findings in an issue like the Rust ones", () => {
    const advisories = read("advisories.yml");
    assert.match(advisories, /^ {2}pnpm-audit:$/m);
    assert.match(advisories, /Security advisories found in JavaScript dependencies/);
  });
});

const REPO = "getoxide/oxide";
const signaturesFor = () => Object.fromEntries(UPDATER_PLATFORMS.map(({ asset }) => [asset, `SIG ${asset}`]));

describe("checkUpdaterSignature", () => {
  // Made once with `tauri signer generate` and `tauri signer sign` on DATA, with a throwaway key.
  const DATA = Buffer.from("oxide updater fixture\n");
  const PUBKEY = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDA1NTU0NkM0QTM5MTRBOUUKUldTZVNwR2p4RVpWQmFaanNhTmw3emNWcDJlVkZyalpuK1R3clUzZXVadDFMb3dmM0xEcHNqTXIK";
  const SIGNATURE = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTZVNwR2p4RVpWQlNGcnVVZElxNDk5aitOakZ5TllmZGk3TTVIU1ZKZkRkclZtdmx1VE5JeEJGK3NheHJ6SVBqVlBEV3VYSkQybE9yTUx3SloxaGhXb0N3YTIreDVVYmc0PQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk1Njk0MzUxCWZpbGU6ZGF0YS5iaW4KeTF1T282aXFVZWZyeWlpb2JDZ3hUSm9JMU42bnA1bEoydzJhSUdyb2NhZ3prRjRQS0VPUkoweXRpMm5lVjlZZ1c3SHh4akU3b3hGeFc2ZTY5bDJjQVE9PQo=";
  const decoded = (base64) => Buffer.from(base64, "base64").toString("utf8");
  const encoded = (text) => Buffer.from(text, "utf8").toString("base64");

  test("a signature made by the key accepts the package", () => {
    assert.equal(checkUpdaterSignature({ pubkey: PUBKEY, signature: SIGNATURE, data: DATA, name: "pkg" }).ok, true);
  });

  test("a changed package is refused", () => {
    const result = checkUpdaterSignature({ pubkey: PUBKEY, signature: SIGNATURE, data: Buffer.from("oxide updater fixturE\n"), name: "pkg" });
    assert.equal(result.ok, false);
    assert.match(result.message, /pkg/);
  });

  test("a signature by another key is refused, naming both key ids", () => {
    const conf = JSON.parse(readFileSync(fileURLToPath(new URL("../../crates/oxide-app/tauri.conf.json", import.meta.url)), "utf8"));
    const result = checkUpdaterSignature({ pubkey: conf.plugins.updater.pubkey, signature: SIGNATURE, data: DATA, name: "pkg" });
    assert.equal(result.ok, false);
    assert.match(result.message, /key/);
  });

  test("a changed trusted comment is refused", () => {
    const tampered = encoded(decoded(SIGNATURE).replace("file:data.bin", "file:other.bin"));
    assert.equal(checkUpdaterSignature({ pubkey: PUBKEY, signature: tampered, data: DATA, name: "pkg" }).ok, false);
  });

  test("a malformed signature or key is refused, not thrown", () => {
    assert.equal(checkUpdaterSignature({ pubkey: PUBKEY, signature: "not base64 at all", data: DATA, name: "pkg" }).ok, false);
    assert.equal(checkUpdaterSignature({ pubkey: "", signature: SIGNATURE, data: DATA, name: "pkg" }).ok, false);
  });
});

describe("buildUpdateFeed", () => {
  const input = (overrides = {}) => ({ tag: "v0.1.0", repository: REPO, signatures: signaturesFor("0.1.0"), pubDate: "2026-12-01T10:00:00Z", ...overrides });

  test("names every in-app platform with the signed package of that release", () => {
    const feed = buildUpdateFeed(input());
    assert.equal(feed.version, "0.1.0");
    assert.equal(feed.pub_date, "2026-12-01T10:00:00Z");
    assert.deepEqual(Object.keys(feed.platforms).sort(), ["darwin-aarch64", "linux-aarch64", "linux-x86_64", "windows-aarch64", "windows-x86_64"]);
    assert.deepEqual(feed.platforms["darwin-aarch64"], {
      url: "https://github.com/getoxide/oxide/releases/download/v0.1.0/Oxide.app.tar.gz",
      signature: "SIG Oxide.app.tar.gz",
    });
    assert.equal(feed.platforms["windows-x86_64"].url, "https://github.com/getoxide/oxide/releases/download/v0.1.0/Oxide-x64.exe");
    assert.equal(feed.platforms["linux-aarch64"].url, "https://github.com/getoxide/oxide/releases/download/v0.1.0/Oxide-arm64.AppImage");
  });

  test("points the notes at the release page", () => {
    assert.equal(buildUpdateFeed(input()).notes, "https://github.com/getoxide/oxide/releases/tag/v0.1.0");
  });

  test("rejects a missing signature, naming the package", () => {
    const signatures = signaturesFor("0.1.0");
    delete signatures["Oxide-arm64.exe"];
    assert.throws(() => buildUpdateFeed(input({ signatures })), /Oxide-arm64\.exe/);
  });

  test("rejects an empty or blank signature", () => {
    for (const blank of ["", "  \n"]) {
      const signatures = { ...signaturesFor("0.1.0"), "Oxide-x64.AppImage": blank };
      assert.throws(() => buildUpdateFeed(input({ signatures })), /Oxide-x64\.AppImage/);
    }
  });

  test("rejects a tag that is not a version", () => {
    assert.throws(() => buildUpdateFeed(input({ tag: "main" })), /tag/);
  });

  test("keeps a pre-release version whole", () => {
    assert.equal(buildUpdateFeed(input({ tag: "v0.2.0-rc.1", signatures: signaturesFor("0.2.0-rc.1") })).version, "0.2.0-rc.1");
  });
});

describe("updater-only assets", () => {
  test("are the macOS archive, every signature and the feed", () => {
    for (const name of ["Oxide.app.tar.gz", "Oxide-x64.exe.sig", "latest.json"]) assert.ok(isUpdaterOnlyAsset(name), name);
    for (const name of ["Oxide.dmg", "Oxide-x64.exe", "Oxide-x64.AppImage"]) assert.ok(!isUpdaterOnlyAsset(name), name);
  });

  test("the Downloads table ignores them", () => {
    assert.equal(downloadsSection(["Oxide.app.tar.gz", "Oxide-x64.exe.sig", "latest.json"]), "");
  });

  test("the notes' checksum list drops them and keeps the installers", () => {
    const sums = ["aaa  Oxide.dmg", "bbb  Oxide.app.tar.gz", "ccc  Oxide-x64.exe.sig", "ddd  Oxide-x64.exe", "eee  latest.json"].join("\n") + "\n";
    assert.equal(releaseChecksums(sums), "aaa  Oxide.dmg\nddd  Oxide-x64.exe\n");
  });
});

describe("checkPublishedFeeds", () => {
  const feed = (version, tag = `v${version}`) => buildUpdateFeed({ tag, repository: REPO, signatures: signaturesFor(version), pubDate: "2026-12-01T10:00:00Z" });

  test("a stable release must be named by both feeds", () => {
    assert.equal(checkPublishedFeeds({ tag: "v0.1.0", stable: feed("0.1.0"), prerelease: feed("0.1.0") }).ok, true);
    const stale = checkPublishedFeeds({ tag: "v0.1.0", stable: feed("0.0.9"), prerelease: feed("0.1.0") });
    assert.equal(stale.ok, false);
    assert.match(stale.message, /stable feed/);
    assert.equal(checkPublishedFeeds({ tag: "v0.1.0", stable: feed("0.1.0"), prerelease: feed("0.0.9") }).ok, false);
  });

  test("a pre-release is named by the pre-release feed and never by the stable one", () => {
    assert.equal(checkPublishedFeeds({ tag: "v0.2.0-rc.1", stable: feed("0.1.0"), prerelease: feed("0.2.0-rc.1") }).ok, true);
    const leaked = checkPublishedFeeds({ tag: "v0.2.0-rc.1", stable: feed("0.2.0-rc.1"), prerelease: feed("0.2.0-rc.1") });
    assert.equal(leaked.ok, false);
    assert.match(leaked.message, /stable feed/);
  });

  test("an entry with an empty signature or a foreign URL fails", () => {
    const bad = feed("0.1.0");
    bad.platforms["linux-x86_64"].signature = "";
    assert.equal(checkPublishedFeeds({ tag: "v0.1.0", stable: bad, prerelease: feed("0.1.0") }).ok, false);
    const foreign = feed("0.1.0");
    foreign.platforms["linux-x86_64"].url = "https://example.com/Oxide.AppImage";
    assert.equal(checkPublishedFeeds({ tag: "v0.1.0", stable: feed("0.1.0"), prerelease: foreign }).ok, false);
  });

  test("a missing feed fails", () => {
    assert.equal(checkPublishedFeeds({ tag: "v0.1.0", stable: undefined, prerelease: feed("0.1.0") }).ok, false);
  });

  test("feedUrls lists every package URL for the reachability check", () => {
    assert.equal(feedUrls(feed("0.1.0")).length, 5);
  });
});

describe("repositoryPlan", () => {
  const REPO_ASSETS = [
    `Oxide-x64.deb`, `Oxide-arm64.deb`, `Oxide-x64.rpm`, `Oxide-arm64.rpm`,
    `Oxide-x64.AppImage`, `Oxide.dmg`, `Oxide-x64.exe`, "latest.json",
  ];

  test("the packages of a repository are the one .deb and one .rpm of each architecture, and nothing else", () => {
    const plan = repositoryPlan({ tag: "v1.2.3", repository: "getoxide/oxide", assetNames: REPO_ASSETS });
    assert.deepEqual(plan.debs, [
      { name: "Oxide-x64.deb", arch: "amd64" },
      { name: "Oxide-arm64.deb", arch: "arm64" },
    ]);
    assert.deepEqual(plan.rpms, [
      { name: "Oxide-x64.rpm", arch: "x86_64" },
      { name: "Oxide-arm64.rpm", arch: "aarch64" },
    ]);
  });

  test("a missing package is an error", () => {
    const without = REPO_ASSETS.filter((name) => name !== "Oxide-arm64.rpm");
    assert.throws(() => repositoryPlan({ tag: "v1.2.3", repository: "getoxide/oxide", assetNames: without }), /Oxide-arm64\.rpm/);
    assert.throws(() => repositoryPlan({ tag: "main", repository: "getoxide/oxide", assetNames: [] }), /not a release tag/);
  });

  test("a stable release writes the DNF metadata, whose packages are the release's own assets", () => {
    const { dnf, stable } = repositoryPlan({ tag: "v1.2.3", repository: "getoxide/oxide", assetNames: REPO_ASSETS });
    assert.equal(stable, true);
    assert.deepEqual(dnf, { publish: true, baseUrl: "https://github.com/getoxide/oxide/releases/download/v1.2.3/", sitePath: "rpm" });
  });

  test("a pre-release is signed for rehearsal but never enters the DNF repository", () => {
    const { dnf, stable } = repositoryPlan({ tag: "v1.3.0-rc.1", repository: "getoxide/oxide", assetNames: REPO_ASSETS });
    assert.equal(stable, false);
    assert.equal(dnf.publish, false);
    assert.equal(dnf.baseUrl, "https://github.com/getoxide/oxide/releases/download/v1.3.0-rc.1/");
  });

  test("the APT repository is these release assets, next to the public key", () => {
    assert.deepEqual(APT_REPOSITORY_FILES, ["InRelease", "Release", "Packages"]);
    assert.deepEqual(REPOSITORY_KEY_FILES, ["oxide-repository.gpg", "oxide-repository.asc"]);
    assert.deepEqual(repositoryPlan({ tag: "v1.2.3", repository: "getoxide/oxide", assetNames: REPO_ASSETS }).aptFiles, [...APT_REPOSITORY_FILES, ...REPOSITORY_KEY_FILES]);
  });

  test("the release needs both repository secrets", () => {
    assert.deepEqual(REPOSITORY_SECRETS, ["OXIDE_REPOSITORY_SIGNING_KEY", "OXIDE_REPOSITORY_SIGNING_KEY_PASSPHRASE"]);
    assert.deepEqual(missingSecrets({ OXIDE_REPOSITORY_SIGNING_KEY: "-----BEGIN" }, REPOSITORY_SECRETS), ["OXIDE_REPOSITORY_SIGNING_KEY_PASSPHRASE"]);
  });
});

describe("repository index files", () => {
  test("the APT Release file pins the Packages index by SHA-256 and size and names both architectures", () => {
    // sha256("abc") is the NIST test vector.
    assert.equal(aptReleaseFile({ packagesText: "abc", date: "Thu, 26 Nov 2026 10:00:00 UTC" }), [
      "Origin: Oxide",
      "Label: Oxide",
      "Suite: stable",
      "Date: Thu, 26 Nov 2026 10:00:00 UTC",
      "Architectures: amd64 arm64",
      "Description: Oxide Linux packages",
      "SHA256:",
      " ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad 3 Packages",
      "",
    ].join("\n"));
  });

  test("the size is in bytes, not characters", () => {
    assert.match(aptReleaseFile({ packagesText: "é", date: "d" }), / 2 Packages\n$/);
  });

  test("the DNF repo file checks package and metadata signatures against the update site's key", () => {
    assert.equal(dnfRepoFile(), [
      "[oxide]",
      "name=Oxide",
      "baseurl=https://updates.getoxide.dev/rpm/",
      "enabled=1",
      "gpgcheck=1",
      "repo_gpgcheck=1",
      "gpgkey=https://updates.getoxide.dev/rpm/oxide-repository.asc",
      "metadata_expire=6h",
      "skip_if_unavailable=1",
      "",
    ].join("\n"));
  });

  test("the APT source file is the documented one-line source, signed by the Oxide keyring", () => {
    assert.equal(aptSourceFile(), "deb [signed-by=/usr/share/keyrings/oxide.gpg] https://updates.getoxide.dev/apt/ ./\n");
    assert.equal(APT_SOURCE_PATH, "/etc/apt/sources.list.d/oxide.list");
    assert.equal(APT_KEYRING_PATH, "/usr/share/keyrings/oxide.gpg");
    assert.equal(DNF_REPO_PATH, "/etc/yum.repos.d/oxide.repo");
  });

  test("repository files and the key are release assets, kept out of the notes' checksums", () => {
    for (const name of ["InRelease", "Release", "Packages", "oxide-repository.gpg", "oxide-repository.asc", "dnf-site.tar.gz"]) assert.ok(isRepositoryAsset(name), name);
    for (const name of ["Oxide-x64.deb", "Oxide-x64.rpm", "latest.json"]) assert.ok(!isRepositoryAsset(name), name);
    assert.equal(releaseChecksums("a  InRelease\nb  Oxide-x64.deb\nc  oxide-repository.asc\nd  dnf-site.tar.gz\n"), "b  Oxide-x64.deb\n");
  });
});

describe("published repositories", () => {
  const assetNames = ["x64", "arm64"].flatMap((arch) => ["deb", "rpm"].map((ext) => `Oxide-${arch}.${ext}`));
  const plan = repositoryPlan({ tag: "v1.2.3", repository: REPO, assetNames });
  const hashes = {
    "Oxide-x64.deb": "a1", "Oxide-arm64.deb": "a2", "Oxide-x64.rpm": "b1", "Oxide-arm64.rpm": "b2",
  };
  const stanza = (name, arch, sha) => `Package: oxide\nVersion: 1.2.3\nArchitecture: ${arch}\nFilename: ./${name}\nSize: 10\nSHA256: ${sha}\n`;
  const packagesText = [stanza("Oxide-x64.deb", "amd64", "a1"), stanza("Oxide-arm64.deb", "arm64", "a2")].join("\n");
  const releaseText = aptReleaseFile({ packagesText, date: "d" });

  test("APT: an index that pins Packages and lists both architectures with the published hashes passes", () => {
    assert.equal(checkAptRepository({ plan, releaseText, packagesText, hashes }).ok, true);
  });

  test("APT: a Packages file the Release does not pin fails", () => {
    const result = checkAptRepository({ plan, releaseText, packagesText: packagesText + "\n", hashes });
    assert.equal(result.ok, false);
    assert.match(result.message, /Release/);
  });

  test("APT: a missing architecture, a wrong hash or a foreign package name fails", () => {
    const one = stanza("Oxide-x64.deb", "amd64", "a1");
    assert.match(checkAptRepository({ plan, releaseText: aptReleaseFile({ packagesText: one, date: "d" }), packagesText: one, hashes }).message, /arm64/);
    const wrong = packagesText.replace("a2", "ff");
    assert.match(checkAptRepository({ plan, releaseText: aptReleaseFile({ packagesText: wrong, date: "d" }), packagesText: wrong, hashes }).message, /Oxide-arm64\.deb/);
    const foreign = packagesText.replace("Package: oxide", "Package: other");
    assert.equal(checkAptRepository({ plan, releaseText: aptReleaseFile({ packagesText: foreign, date: "d" }), packagesText: foreign, hashes }).ok, false);
  });

  const BASE = "https://github.com/getoxide/oxide/releases/download/v1.2.3/";
  const rpmEntry = (name, arch, sha, base = BASE) => `<package type="rpm"><name>oxide</name><arch>${arch}</arch><checksum type="sha256" pkgid="YES">${sha}</checksum><location xml:base="${base}" href="${name}"/></package>`;
  const primaryXml = `<metadata packages="2">${rpmEntry("Oxide-x64.rpm", "x86_64", "b1")}${rpmEntry("Oxide-arm64.rpm", "aarch64", "b2")}</metadata>`;
  const repomd = `<repomd><data type="filelists"><checksum type="sha256">zz</checksum><location href="repodata/f.xml.gz"/></data><data type="primary"><checksum type="sha256">p1</checksum><open-checksum type="sha256">p0</open-checksum><location href="repodata/p1-primary.xml.gz"/></data></repomd>`;

  test("DNF: metadata whose primary hash matches and whose packages are the release's assets passes", () => {
    assert.equal(checkDnfRepository({ plan, repomd, primaryXml, primarySha256: "p1", hashes }).ok, true);
  });

  test("DNF: a primary file that does not match repomd fails", () => {
    const result = checkDnfRepository({ plan, repomd, primaryXml, primarySha256: "other", hashes });
    assert.equal(result.ok, false);
    assert.match(result.message, /repomd/);
  });

  test("DNF: a wrong package hash, a missing arch or a foreign location fails", () => {
    assert.match(checkDnfRepository({ plan, repomd, primaryXml: primaryXml.replace("b2", "ff"), primarySha256: "p1", hashes }).message, /arm64\.rpm/);
    assert.equal(checkDnfRepository({ plan, repomd, primaryXml: `<metadata>${rpmEntry("Oxide-x64.rpm", "x86_64", "b1")}</metadata>`, primarySha256: "p1", hashes }).ok, false);
    assert.equal(checkDnfRepository({ plan, repomd, primaryXml: primaryXml.replaceAll(BASE, "https://example.com/"), primarySha256: "p1", hashes }).ok, false);
  });
});

describe("missingPresent", () => {
  test("names the secrets whose presence flag is not exactly true", () => {
    const env = { HAS_A: "true", HAS_B: "false", HAS_C: "" };
    assert.deepEqual(missingPresent(env, ["A", "B", "C", "D"]), ["B", "C", "D"]);
    assert.deepEqual(missingPresent(env, ["A"]), []);
    assert.deepEqual(missingPresent(undefined, ["A"]), ["A"]);
  });
});

describe("the repository pipeline", () => {
  const read = (name) => readFileSync(fileURLToPath(new URL(`../../.github/workflows/${name}`, import.meta.url)), "utf8");
  const stepsOf = (text) => text.split(/\n {6}- /);

  test("every release build checks the repository signing secrets before it builds anything", () => {
    const build = read("build.yml");
    const step = stepsOf(build).find((candidate) => candidate.includes("require-secrets"));
    for (const secret of REPOSITORY_SECRETS) {
      assert.ok(step.includes(`\${{ secrets.${secret} != '' }}`), `${secret} is not tested for presence by the check`);
      assert.match(step, new RegExp(`require-secrets --present .*${secret}`));
    }
    // The check never puts a key's value into the environment of the build jobs.
    for (const secret of [...REPOSITORY_SECRETS, "TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"]) {
      assert.ok(!step.includes(`\${{ secrets.${secret} }}`), `${secret}'s value is exported by the check`);
    }
    for (const marker of ["./.github/actions/setup-rust", "tauri build"]) assert.ok(build.indexOf(marker) > build.indexOf("require-secrets"), marker);
  });

  test("signing happens in its own approved job, before the draft, and only that job holds the key", () => {
    const release = read("release.yml");
    const job = release.slice(release.indexOf("\n  repositories:"), release.indexOf("\n  publish:"));
    assert.match(job, /needs: build/);
    assert.match(job, /environment: release/);
    assert.ok(job.indexOf("require-secrets") > 0 && job.indexOf("require-secrets") < job.indexOf("sign-repositories.sh"), "the secrets are checked before anything is signed");
    for (const secret of REPOSITORY_SECRETS) assert.ok(job.includes(`secrets.${secret}`), secret);
    const publish = release.slice(release.indexOf("\n  publish:"));
    assert.match(publish, /needs: \[build, repositories\]/);
    for (const secret of REPOSITORY_SECRETS) assert.ok(!publish.includes(secret), `${secret} reaches the publish job`);
    assert.ok(publish.indexOf("gh release create") > publish.indexOf("repository-release"), "the signed files are in the draft");
    for (const secret of REPOSITORY_SECRETS) assert.ok(!read("verify-release.yml").includes(secret), `${secret} reaches verify-release.yml`);
  });

  test("sign-repositories.sh makes its directories absolute before it changes directory", () => {
    // release.yml passes relative paths (linux, repository); the APT index is written from inside a temp folder.
    const script = readFileSync(fileURLToPath(new URL("./sign-repositories.sh", import.meta.url)), "utf8");
    const firstCd = script.search(/^\(cd "/m);
    assert.ok(firstCd > 0, "the script changes directory somewhere");
    for (const dir of ["packages", "out"]) {
      const resolved = script.indexOf(`\n${dir}=$(cd "$${dir}" && pwd)\n`);
      assert.ok(resolved > 0 && resolved < firstCd, `${dir} is made absolute before the first cd`);
    }
  });

  test("the signed .rpm files replace the unsigned ones before the checksums and attestations", () => {
    const publish = read("release.yml");
    const assemble = publish.slice(publish.indexOf("Assemble the deliverables"), publish.indexOf("Upload release metadata"));
    assert.ok(assemble.indexOf("staged-repository") > assemble.indexOf("-name '*.rpm'"), "the signed files are copied after the build's");
    assert.ok(assemble.indexOf("staged-repository") < assemble.indexOf("sha256sum"));
  });

  test("publishing deploys the update site from the release's DNF archive for a stable release only, then checks both repositories", () => {
    const verify = read("verify-release.yml");
    assert.match(verify, /repository-plan/);
    assert.match(verify, /steps\.plan\.outputs\.publish == 'true'/);
    assert.ok(!verify.includes("remote push origin"), "verify-release.yml must not push to an updates branch");
    for (const marker of ["cli.mjs check-apt", "cli.mjs check-dnf", "gpgv", "repomd.xml.asc", "updates.getoxide.dev/apt/", "updates.getoxide.dev/rpm/", "dnf-site.tar.gz"]) assert.ok(verify.includes(marker), marker);
  });

  test("the repository addresses are the ones the setup instructions and docs name", () => {
    const readme = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8");
    for (const text of ["signed-by=/usr/share/keyrings/oxide.gpg] https://updates.getoxide.dev/apt/ ./", "https://updates.getoxide.dev/rpm/oxide.repo"]) {
      assert.ok(readme.includes(text), text);
    }
  });
});

describe("missingSecrets", () => {
  test("lists the secrets that are unset or empty", () => {
    assert.deepEqual(missingSecrets({ A: "x", B: "", C: "  " }, ["A", "B", "C", "D"]), ["B", "C", "D"]);
    assert.deepEqual(missingSecrets({ A: "x" }, ["A"]), []);
  });
});

describe("the update pipeline", () => {
  const read = (name) => readFileSync(fileURLToPath(new URL(`../../.github/workflows/${name}`, import.meta.url)), "utf8");
  const SECRETS = ["TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"];

  test("a release build checks the update signing secrets before it builds anything", () => {
    const build = read("build.yml");
    const check = build.indexOf("require-secrets");
    assert.ok(check > 0, "build.yml never checks the secrets");
    assert.match(build.slice(check, check + 200), /TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD/);
    for (const marker of ["./.github/actions/setup-rust", "pnpm --dir web install", "tauri build", "tauri.cmd build"]) {
      assert.ok(build.indexOf(marker) > check, `${marker} runs before the secrets are checked`);
    }
    // Only a release has secrets to check; CI builds stay unsigned.
    assert.match(build.split(/\n {6}- /).find((step) => step.includes("require-secrets")), /if: inputs\.release/);
  });

  test("only release builds make updater packages, and only build steps see the key", () => {
    const build = read("build.yml");
    // Only the release config asks for updater packages; the shared config does not.
    const shared = readFileSync(fileURLToPath(new URL("../../crates/oxide-app/tauri.conf.json", import.meta.url)), "utf8");
    assert.ok(!shared.includes("createUpdaterArtifacts"), "CI builds have no key, so the shared config must not ask for updater packages");
    const updater = readFileSync(fileURLToPath(new URL("../../crates/oxide-app/tauri.updater.conf.json", import.meta.url)), "utf8");
    assert.equal(JSON.parse(updater).bundle.createUpdaterArtifacts, true);
    assert.match(build, /RELEASE" = "true" \] && echo "crates\/oxide-app\/tauri\.updater\.conf\.json"/);
    for (const step of build.split(/\n {6}- /)) {
      for (const secret of SECRETS) {
        if (step.includes(`secrets.${secret}`)) assert.match(step, /tauri\S* build|require-secrets/, `${secret} is exposed to a step that neither builds nor checks it`);
      }
    }
  });

  test("the build stages a signature next to every updater package", () => {
    const build = read("build.yml");
    for (const marker of [".app.tar.gz", "Oxide-${arch}", ".sig"]) assert.ok(build.includes(marker), marker);
  });

  test("the release publishes latest.json made from the signatures and keeps updater assets out of the notes", () => {
    const release = read("release.yml");
    assert.match(release, /cli\.mjs updater-feed "\$TAG"/);
    assert.match(release, /cli\.mjs release-checksums/);
    assert.ok(release.indexOf("updater-feed") < release.indexOf("sha256sum"), "the feed is written before the checksums and attestations cover it");
  });

  test("publishing deploys the update site without a branch and checks both feeds", () => {
    const verify = read("verify-release.yml");
    assert.match(verify, /wrangler@4\.168\.0/);
    assert.match(verify, /_redirects/);
    assert.match(verify, /cli\.mjs prerelease-feed-url/);
    assert.match(verify, /cli\.mjs check-feeds/);
    assert.match(verify, /cli\.mjs feed-urls/);
    assert.match(verify, /https:\/\/updates\.getoxide\.dev\/latest\.json/);
    assert.match(verify, /https:\/\/api\.github\.com\/repos\/getoxide\/oxide\/releases\?per_page=10/);
    // The workflow that verifies and deploys the site holds no signing key.
    for (const secret of SECRETS) assert.ok(!verify.includes(secret), `${secret} reaches verify-release.yml`);
  });

  test("prereleaseFeedUrl picks the newest non-draft release by semver with a latest.json asset", () => {
    const releases = [
      { tag_name: "v1.0.0-rc.3", draft: true, assets: [{ name: "latest.json", browser_download_url: "https://example.com/rc3.json" }] },
      { tag_name: "v1.0.0-rc.1", draft: false, assets: [{ name: "latest.json", browser_download_url: "https://example.com/rc1.json" }] },
      { tag_name: "v1.0.0-rc.2", draft: false, assets: [{ name: "latest.json", browser_download_url: "https://example.com/rc2.json" }] },
    ];
    assert.equal(prereleaseFeedUrl(releases), "https://example.com/rc2.json");
    assert.equal(prereleaseFeedUrl([]), undefined);
  });

  test("publishing first refuses a pre-release flag that disagrees with the tag, before anything is written", () => {
    const verify = read("verify-release.yml");
    assert.match(verify, /PRERELEASE: \$\{\{ github\.event\.release\.prerelease \}\}/);
    assert.match(verify, /cli\.mjs check-prerelease "\$TAG" "\$PRERELEASE"/);
    const first = verify.indexOf("check-prerelease");
    for (const later of ["gh release download", "wrangler"]) {
      assert.ok(first < verify.indexOf(later), `the flag is checked before ${later}`);
    }
  });

  test("the pipeline's feed addresses are the ones compiled into the app", () => {
    const core = readFileSync(fileURLToPath(new URL("../../crates/oxide-core/src/updates.rs", import.meta.url)), "utf8");
    const verify = read("verify-release.yml");
    for (const url of ["https://updates.getoxide.dev/latest.json", "https://api.github.com/repos/getoxide/oxide/releases?per_page=10"]) {
      assert.ok(core.includes(url), url);
      assert.ok(verify.includes(url), url);
    }
  });
});
