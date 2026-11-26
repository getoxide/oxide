// Thin wrapper over policy.mjs: read files and environment variables, print
// the decision, write step outputs, exit non-zero on a failed check.
//
//   node tools/ci/cli.mjs lanes <changed-files.txt>    env GITHUB_EVENT_NAME, CHANGED_FILES_TOTAL
//   node tools/ci/cli.mjs gate                          env NEEDS_JSON (toJSON(needs)), GITHUB_EVENT_NAME
//   node tools/ci/cli.mjs pr-title                      env PR_TITLE
//   node tools/ci/cli.mjs release-version <tag>
//   node tools/ci/cli.mjs check-prerelease <tag> <true|false>   fails when the release's pre-release flag disagrees with its tag
//   node tools/ci/cli.mjs tauri-alignment
//   node tools/ci/cli.mjs release-notes <tag> [<previous-tag>]
//   node tools/ci/cli.mjs downloads <dir>               prints the Downloads table for the installers in <dir>
//   node tools/ci/cli.mjs require-secrets [--present] <NAME>...   fails naming each secret the environment leaves unset or empty
//                                                       (--present: reads HAS_<NAME>=true|false flags instead of values)
//   node tools/ci/cli.mjs updater-feed <tag> <dir>      prints latest.json from the packages' .sig files in <dir>; fails unless
//                                                       each .sig verifies its package against the app's updater pubkey
//   node tools/ci/cli.mjs release-checksums <file>      prints a sha256sum listing without the updater-only assets
//   node tools/ci/cli.mjs feed-urls <feed.json>         prints every package URL of a feed
//   node tools/ci/cli.mjs prerelease-feed-url <releases.json>   prints latest.json URL of the newest non-draft release
//   node tools/ci/cli.mjs check-feeds <tag> <stable.json> <prerelease.json>
//   node tools/ci/cli.mjs repository-plan <tag> <dir>   fails unless <dir> has every package; writes publish=<DNF metadata goes to the site>
//   node tools/ci/cli.mjs apt-release <Packages>        prints the APT Release file for a Packages index
//   node tools/ci/cli.mjs dnf-repo-file                 prints the .repo file users add for DNF
//   node tools/ci/cli.mjs check-apt <tag> <dir>         <dir> has Release, Packages and the published .deb files
//   node tools/ci/cli.mjs check-dnf <tag> <dir>         <dir> has repomd.xml, the primary file and the published .rpm files
//   node tools/ci/cli.mjs dependabot                    env DEPENDENCIES_JSON
//   node tools/ci/cli.mjs bump <version>                writes the three manifests and Cargo.lock
//
// Untrusted values (titles, file lists) arrive through files and environment
// variables, never through workflow expressions in a shell script.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import {
  bumpVersion, checkPrTitle, checkPrerelease, checkReleaseVersion, checkTauriAlignment, dependabotDecision, evaluateGate, lanesFor,
  aptReleaseFile, checkAptRepository, checkDnfRepository, dnfRepoFile, downloadsSection, prereleaseFeedUrl, previousReleaseTag, releaseNotes, repositoryPlan, UPDATER_PLATFORMS, buildUpdateFeed, checkPublishedFeeds, checkUpdaterSignature, feedUrls, missingPresent, missingSecrets, releaseChecksums,
} from "./policy.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const read = (path) => readFileSync(join(repoRoot, path), "utf8");
const MANIFESTS = {
  cargoToml: "Cargo.toml", tauriConf: "crates/oxide-app/tauri.conf.json", webPackage: "web/package.json", cargoLock: "Cargo.lock",
};

const readIn = (dir, name) => readFileSync(join(dir, name), "utf8");
/** The repository the workflow runs for; Oxide itself when run by hand. */
const repo = () => process.env.GITHUB_REPOSITORY ?? "getoxide/oxide";
const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function output(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${String(value).replace(/\r?\n|\r/g, " ")}\n`).join(""));
}

function report({ ok, message }) {
  if (ok) console.log(message);
  else console.error(process.env.GITHUB_ACTIONS === "true" ? `::error::${message}` : message);
  process.exitCode = ok ? 0 : 1;
}

function git(...args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

function earlierTags(tag) {
  try { return git("tag", "--list", "v*", "--merged", `${tag}^`, "--sort=-v:refname").split(/\r?\n/).filter(Boolean); } catch { return []; }
}

function workspaceMembers() {
  const members = read("Cargo.toml").match(/^members\s*=\s*\[([^\]]*)\]/m)?.[1].match(/"[^"]+"/g) ?? [];
  return members.map((member) => read(`${member.slice(1, -1)}/Cargo.toml`).match(/^name\s*=\s*"([^"]+)"/m)[1]);
}

const commands = {
  lanes([listFile]) {
    const files = listFile && existsSync(listFile)
      ? readFileSync(listFile, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      : undefined;
    const total = Number.parseInt(process.env.CHANGED_FILES_TOTAL ?? "", 10);
    const lanes = lanesFor(files, process.env.GITHUB_EVENT_NAME, Number.isNaN(total) ? {} : { total });
    console.log(Object.entries(lanes).map(([lane, on]) => `${lane}: ${on ? "on" : "off"}`).join("\n"));
    output(lanes);
  },
  gate() {
    const needs = JSON.parse(process.env.NEEDS_JSON || "{}");
    report(evaluateGate(needs, needs.changes?.outputs, process.env.GITHUB_EVENT_NAME));
  },
  "pr-title"() {
    report(checkPrTitle(process.env.PR_TITLE));
  },
  "release-version"([tag]) {
    report(checkReleaseVersion({ tag, cargoToml: read(MANIFESTS.cargoToml), tauriConf: read(MANIFESTS.tauriConf), webPackage: read(MANIFESTS.webPackage) }));
  },
  "check-prerelease"([tag, prerelease]) {
    report(checkPrerelease({ tag, prerelease }));
  },
  "tauri-alignment"() {
    report(checkTauriAlignment({ cargoLock: read(MANIFESTS.cargoLock), pnpmLock: read("web/pnpm-lock.yaml") }));
  },
  "release-notes"([tag, previous = previousReleaseTag(tag, earlierTags(tag))]) {
    const range = previous ? `${previous}..${tag}` : tag;
    const commits = git("log", "--format=%s%x1f%b%x1e", range).split("\x1e").map((entry) => entry.trim()).filter(Boolean)
      .map((entry) => { const [subject, body = ""] = entry.split("\x1f"); return { subject, body }; });
    process.stdout.write(releaseNotes(commits, { repository: repo(), previousTag: previous, tag }));
  },
  downloads([dir]) {
    process.stdout.write(downloadsSection(readdirSync(dir)));
  },
  "require-secrets"(args) {
    // With --present the environment carries HAS_<NAME>=true|false flags (from `secrets.X != ''`), never a value.
    const present = args[0] === "--present";
    const names = present ? args.slice(1) : args;
    const missing = (present ? missingPresent : missingSecrets)(process.env, names);
    report(missing.length > 0
      ? { ok: false, message: `The release environment has no value for: ${missing.join(", ")}. Add ${missing.length > 1 ? "them" : "it"} as secret${missing.length > 1 ? "s" : ""} of the \`release\` environment before tagging.` }
      : { ok: true, message: `The release environment has ${names.join(", ")}.` });
  },
  "updater-feed"([tag, dir]) {
    const version = String(tag ?? "").replace(/^v/, "");
    const signatures = {};
    const pubkey = JSON.parse(read("crates/oxide-app/tauri.conf.json")).plugins.updater.pubkey;
    for (const { asset } of UPDATER_PLATFORMS) {
      const path = join(dir, `${asset(version)}.sig`);
      if (!existsSync(path)) continue;
      signatures[asset(version)] = readFileSync(path, "utf8");
      // A package signed by another key than the one compiled into the app would be refused by every install.
      const packagePath = join(dir, asset(version));
      const check = existsSync(packagePath)
        ? checkUpdaterSignature({ pubkey, signature: signatures[asset(version)], data: readFileSync(packagePath), name: asset(version) })
        : { ok: false, message: `${asset(version)} is missing next to its signature.` };
      if (!check.ok) throw new Error(check.message);
    }
    const pubDate = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    process.stdout.write(`${JSON.stringify(buildUpdateFeed({ tag, repository: repo(), signatures, pubDate }), null, 2)}\n`);
  },
  "release-checksums"([file]) {
    process.stdout.write(releaseChecksums(readFileSync(file, "utf8")));
  },
  "feed-urls"([file]) {
    console.log(feedUrls(JSON.parse(readFileSync(file, "utf8"))).join("\n"));
  },
  "prerelease-feed-url"([file]) {
    const url = prereleaseFeedUrl(JSON.parse(readFileSync(file, "utf8")));
    if (url) process.stdout.write(url);
  },
  "check-feeds"([tag, stableFile, prereleaseFile]) {
    const parse = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; } };
    report(checkPublishedFeeds({ tag, stable: parse(stableFile), prerelease: parse(prereleaseFile), repository: repo() }));
  },
  "repository-plan"([tag, dir]) {
    const plan = repositoryPlan({ tag, repository: repo(), assetNames: readdirSync(dir) });
    console.log(JSON.stringify(plan, null, 2));
    output({ publish: plan.dnf.publish, stable: plan.stable, baseUrl: plan.dnf.baseUrl });
  },
  "apt-release"([packagesFile]) {
    process.stdout.write(aptReleaseFile({ packagesText: readFileSync(packagesFile, "utf8"), date: new Date().toUTCString().replace("GMT", "UTC") }));
  },
  "dnf-repo-file"() {
    process.stdout.write(dnfRepoFile());
  },
  "check-apt"([tag, dir]) {
    const plan = repositoryPlan({ tag, repository: repo(), assetNames: readdirSync(dir) });
    const hashes = Object.fromEntries(plan.debs.map(({ name }) => [name, sha256File(join(dir, name))]));
    report(checkAptRepository({ plan, releaseText: readIn(dir, "Release"), packagesText: readIn(dir, "Packages"), hashes }));
  },
  "check-dnf"([tag, dir]) {
    const plan = repositoryPlan({ tag, repository: repo(), assetNames: readdirSync(dir) });
    const hashes = Object.fromEntries(plan.rpms.map(({ name }) => [name, sha256File(join(dir, name))]));
    const repomd = readIn(dir, "repomd.xml");
    const primary = basename(repomd.match(/<data type="primary">[\s\S]*?<location href="([^"]+)"/)?.[1] ?? "");
    if (!primary) { report({ ok: false, message: "repomd.xml names no primary file." }); return; }
    const primaryBytes = readFileSync(join(dir, primary));
    const primaryXml = gunzipSync(primaryBytes).toString("utf8");
    report(checkDnfRepository({ plan, repomd, primaryXml, primarySha256: createHash("sha256").update(primaryBytes).digest("hex"), hashes }));
  },
  dependabot() {
    let dependencies;
    try { dependencies = JSON.parse(process.env.DEPENDENCIES_JSON || "[]"); } catch { dependencies = undefined; }
    const { decision, reason } = dependabotDecision(dependencies);
    console.log(`${decision}: ${reason}`);
    output({ decision, reason });
  },
  bump([version]) {
    const current = Object.fromEntries(Object.entries(MANIFESTS).map(([key, path]) => [key, read(path)]));
    const bumped = bumpVersion(current, version ?? "", { members: workspaceMembers() });
    for (const [key, path] of Object.entries(MANIFESTS)) {
      if (bumped[key] !== current[key]) writeFileSync(join(repoRoot, path), bumped[key]);
    }
    const next = version.replace(/^v/, "");
    console.log(`Version ${next} written to ${Object.values(MANIFESTS).join(", ")}.`);
    console.log(`Open a PR titled "chore(release): v${next}"; once its main run passes the gate, tag that commit v${next}.`);
  },
};

const [name, ...args] = process.argv.slice(2);
if (!commands[name]) {
  console.error(`Usage: node tools/ci/cli.mjs <${Object.keys(commands).join("|")}> [arguments]`);
  process.exitCode = 2;
} else {
  try {
    commands[name](args);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
