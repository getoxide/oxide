// Every decision the CI/CD pipeline makes, as pure functions. Workflows and
// the local runner only gather inputs and act on the answers (see cli.mjs).
import { createHash, createPublicKey, verify } from "node:crypto";

const LANES = ["web", "rust", "bundle", "supplyChain", "automation"];
const allLanes = (on) => Object.fromEntries(LANES.map((lane) => [lane, on]));
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

// The shared build workflow, called by CI for bundles and by Release.
const BUILD_WORKFLOW = ".github/workflows/build.yml";

// Each rule names the lanes a path can affect. A path must match at least one
// rule; `[]` marks paths that affect no lane (docs, notes).
const PATH_RULES = [
  [/^crates\//, ["rust"]],
  [/^(Cargo\.toml|Cargo\.lock|rust-toolchain\.toml|\.cargo\/.*|\.config\/nextest\.toml)$/, ["rust"]],
  [/^\.github\/actions\/setup-rust\//, ["rust", "bundle"]], // the shared Rust setup: toolchain, cache, libclang, Linux libraries
  [/^web\/src\/bindings\.ts$/, ["rust"]], // also web: the Rust tests generate what the web app imports
  [/^web\//, ["web"]],
  [/^\.node-version$/, ["web", "bundle"]],
  // Packaging inputs: only `tauri build` can break these.
  [/^crates\/oxide-app\/(tauri(\.[\w-]+)?\.conf\.json|Info\.plist|capabilities\/.*|icons(-dev)?\/.*)$/, ["bundle"]],
  [/^docs\/licenses\//, ["bundle"]], // bundled as app resources
  // The .deb and .rpm maintainer scripts and the key they install: bundled by `tauri build`, tested by
  // tools/ci/maintainer-scripts.test.mjs (the automation lane).
  [/^crates\/oxide-app\/linux\//, ["bundle", "automation"]],
  [/^(Cargo\.toml|Cargo\.lock|crates\/[^/]+\/Cargo\.toml|web\/package\.json|web\/pnpm-lock\.yaml)$/, ["bundle", "supplyChain"]],
  [/^(crates\/[^/]+\/build\.rs|tools\/build\.mjs|tools\/checks\/.*)$/, ["bundle"]],
  [new RegExp(`^${escapeRegExp(BUILD_WORKFLOW)}$`), ["bundle"]],
  [/^(web\/pnpm-workspace\.yaml|deny\.toml)$/, ["supplyChain"]],
  [/^(\.github|tools)\//, ["automation"]],
  [/^(docs|assets|\.agents|\.impeccable)\//, []],
  [/^[^/]+\.md$/, []],
  [/^(LICENSE|CITATION\.cff|llms\.txt|\.gitignore|\.gitmodules)$/, []],
];

function lanesForPath(path) {
  const matched = PATH_RULES.filter(([pattern]) => pattern.test(path));
  return matched.length === 0 ? undefined : matched.flatMap(([, on]) => on);
}

// The pull request files API lists at most this many files.
const MAX_LISTED_FILES = 3000;

/**
 * Which CI lanes a change can affect. Fails open: every lane runs unless the
 * event is a pull request with a complete list of paths that every rule knows.
 * `total` is the PR's changed-file count; a shorter list was truncated (a
 * longer one is fine: renames list both paths).
 */
export function lanesFor(changedFiles, event, { total } = {}) {
  if (event !== "pull_request" || !Array.isArray(changedFiles) || changedFiles.length === 0) return allLanes(true);
  if (changedFiles.length >= MAX_LISTED_FILES || total > changedFiles.length) return allLanes(true);
  const result = allLanes(false);
  for (const path of changedFiles) {
    const on = lanesForPath(path);
    if (!on) return allLanes(true);
    for (const lane of on) result[lane] = true;
  }
  return result;
}

// The lane each CI job belongs to. Jobs not listed here must always run.
const JOB_LANES = {
  web: "web", "rust-fmt": "rust", rust: "rust", "supply-chain": "supplyChain", automation: "automation", bundle: "bundle",
};
const PULL_REQUEST_ONLY_JOBS = new Set(["pr-title"]);

function mayBeSkipped(job, lanes, event) {
  if (PULL_REQUEST_ONLY_JOBS.has(job)) return event !== "pull_request";
  // A lane counts as off only when it was explicitly turned off.
  const lane = lanes?.[JOB_LANES[job]];
  return job in JOB_LANES && (lane === false || lane === "false");
}

/**
 * The single required check. `jobResults` maps job ids to a result, or to the
 * workflow's `needs` entries; `lanes` may be booleans or step-output strings.
 * A job passes only if it succeeded, or was skipped because its lane was off or
 * its event doesn't apply.
 */
export function evaluateGate(jobResults, lanes, event) {
  const jobs = Object.entries(jobResults ?? {}).map(([job, value]) => [job, typeof value === "string" ? value : value?.result]);
  if (jobs.length === 0) return { ok: false, message: "No job results reached the gate." };
  const problems = [];
  for (const [job, result] of jobs) {
    if (result === "success") continue;
    if (result === "skipped" && mayBeSkipped(job, lanes, event)) continue;
    if (result === "skipped") problems.push(`${job} was skipped although it had to run`);
    else problems.push(`${job} ${{ failure: "failed", cancelled: "was cancelled" }[result] ?? `ended with ${result ?? "no result"}`}`);
  }
  if (problems.length > 0) return { ok: false, message: `Gate failed: ${problems.join("; ")}.` };
  const skipped = jobs.filter(([, result]) => result === "skipped").map(([job]) => job);
  return { ok: true, message: `Gate passed: ${jobs.length - skipped.length} jobs succeeded${skipped.length ? `, skipped as not affected: ${skipped.join(", ")}` : ""}.` };
}

// The git-workflow branch types, plus the other Conventional Commit types we use.
const TITLE_TYPES = ["feat", "fix", "docs", "chore", "refactor", "test", "research", "perf", "build", "ci", "revert"];
const CONVENTIONAL = /^(?<type>[a-z]+)(?:\((?<scope>[^()\s][^()]*)\))?(?<breaking>!)?: (?<description>\S.*)$/;

function parseTitle(title) {
  const match = String(title ?? "").trim().match(CONVENTIONAL);
  return match && TITLE_TYPES.includes(match.groups.type) ? match.groups : undefined;
}

/** The squash title becomes the main commit and its release-notes line. */
export function checkPrTitle(title) {
  if (parseTitle(title)) return { ok: true, message: `PR title is a valid Conventional Commit: ${title}` };
  return {
    ok: false,
    message: `PR title "${title ?? ""}" is not a Conventional Commit. Use "<type>(<scope>): <description>", where the scope is optional, ` +
      `"!" before the colon marks a breaking change, and <type> is one of: ${TITLE_TYPES.join(", ")}. ` +
      `Example: "fix(terminal): keep input focus after a resize".`,
  };
}

// Windows checkouts may convert line endings; parse both the same way.
const lf = (text) => String(text ?? "").replace(/\r\n/g, "\n");
// A release is X.Y.Z, or X.Y.Z-rc.N for a release candidate.
const VERSION = String.raw`\d+\.\d+\.\d+(?:-rc\.\d+)?`;
const RELEASE_VERSION = new RegExp(`^${VERSION}$`);
const TAG = new RegExp(`^v(${VERSION})$`);
// Groups: everything before the value, the value, the closing quote.
const WORKSPACE_PACKAGE = /^(\[workspace\.package\]\r?\n(?:(?!\[).*\n)*?version\s*=\s*")([^"]*)(")/m;

// The version lives in three places; they and the tag must agree.
const VERSION_FILES = {
  cargoToml: { path: "Cargo.toml", read: (text) => text.match(WORKSPACE_PACKAGE)?.[2] },
  tauriConf: { path: "crates/oxide-app/tauri.conf.json", read: (text) => JSON.parse(text).version },
  webPackage: { path: "web/package.json", read: (text) => JSON.parse(text).version },
};

function declaredVersion(key, text) {
  try { return VERSION_FILES[key].read(text); } catch { return undefined; }
}

/** A release tag must equal the version of the workspace, the Tauri config and the web app. */
export function checkReleaseVersion({ tag, cargoToml, tauriConf, webPackage }) {
  const tagVersion = String(tag ?? "").match(TAG)?.[1];
  if (!tagVersion) return { ok: false, message: `Tag "${tag ?? ""}" is not of the form vX.Y.Z or vX.Y.Z-rc.N.` };
  const files = { cargoToml, tauriConf, webPackage };
  const mismatched = Object.keys(VERSION_FILES)
    .map((key) => [VERSION_FILES[key].path, declaredVersion(key, files[key])])
    .filter(([, version]) => version !== tagVersion);
  if (mismatched.length > 0) {
    const list = mismatched.map(([file, version]) => `${file} ${version ?? "(unreadable)"}`).join(", ");
    return {
      ok: false,
      message: `Tag ${tag} does not match the declared version: ${list}. Run "node tools/ci/cli.mjs bump ${tagVersion}" in a PR into main before tagging.`,
    };
  }
  return { ok: true, message: `Tag ${tag} matches Cargo.toml, tauri.conf.json and web/package.json.` };
}

/**
 * The release's pre-release flag must agree with its tag: flagged if and only if the tag has a "-" suffix.
 * The APT and DNF repositories and the stable feed trust the flag (GitHub's "latest" skips pre-releases), and
 * the package scripts trust the tag, so a hand-set flag would break one of them.
 */
export function checkPrerelease({ tag, prerelease }) {
  const flag = String(prerelease ?? "").toLowerCase();
  if (flag !== "true" && flag !== "false") return { ok: false, message: `The pre-release flag of release ${tag ?? ""} is "${prerelease ?? ""}", not true or false.` };
  const flagged = flag === "true";
  const suffixed = String(tag ?? "").includes("-");
  if (flagged === suffixed) return { ok: true, message: `Release ${tag} is ${flagged ? "" : "not "}marked as a pre-release, as its tag says.` };
  return {
    ok: false,
    message: suffixed
      ? `Release ${tag} has a pre-release tag (a "-" suffix) but is not marked as a pre-release. Nothing was written. Re-draft it with the pre-release box ticked, or tag a stable version.`
      : `Release ${tag} is a stable tag but is marked as a pre-release, so GitHub's "latest" skips it and the repositories and feeds would never serve it. Nothing was written. Untick "Set as a pre-release" on the release (a stable release is never one).`,
  };
}

function setJsonVersion(text, version, file) {
  // Edit the text, not a re-serialised object, so hand formatting survives.
  const updated = text.replace(/^(\s*"version"\s*:\s*")[^"]*(")/m, `$1${version}$2`);
  if (JSON.parse(updated).version !== version) throw new Error(`Cannot find the top-level version in ${file}.`);
  return updated;
}

/**
 * Bump the release version in every place it is declared. `members` are the
 * workspace package names whose `Cargo.lock` entries carry that version.
 */
export function bumpVersion({ cargoToml, tauriConf, webPackage, cargoLock }, version, { members }) {
  const next = String(version).replace(/^v/, "");
  if (!RELEASE_VERSION.test(next)) throw new Error(`"${version}" is not a version of the form X.Y.Z or X.Y.Z-rc.N.`);
  if (!WORKSPACE_PACKAGE.test(cargoToml)) throw new Error("Cannot find the version in [workspace.package] of Cargo.toml.");
  const bumped = {
    cargoToml: cargoToml.replace(WORKSPACE_PACKAGE, `$1${next}$3`),
    tauriConf: setJsonVersion(tauriConf, next, VERSION_FILES.tauriConf.path),
    webPackage: setJsonVersion(webPackage, next, VERSION_FILES.webPackage.path),
    cargoLock,
  };
  for (const name of members) {
    // Workspace packages are the lock entries without a `source` line.
    const entry = new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "${name}"\\r?\\nversion = ")[^"]*("\\r?\\n(?!source = ))`);
    if (!entry.test(bumped.cargoLock)) throw new Error(`Cannot find the workspace package ${name} in Cargo.lock.`);
    bumped.cargoLock = bumped.cargoLock.replace(entry, `$1${next}$2`);
  }
  return bumped;
}

// `tauri build` refuses a `tauri` crate and JS packages on different major.minor.
const TAURI_JS_PACKAGES = ["@tauri-apps/api", "@tauri-apps/cli"];
const majorMinor = (version) => version.split(".").slice(0, 2).join(".");

/** Catch a half-landed Tauri bump in the PR instead of at release. */
export function checkTauriAlignment({ cargoLock, pnpmLock }) {
  const crate = lf(cargoLock).match(/\[\[package\]\]\nname = "tauri"\nversion = "([^"]+)"/)?.[1];
  if (!crate) return { ok: false, message: "The tauri crate was not found in Cargo.lock." };
  const problems = [];
  for (const name of TAURI_JS_PACKAGES) {
    // The resolved version in the `importers` section of a pnpm v9 lockfile.
    const version = lf(pnpmLock).match(new RegExp(`'${escapeRegExp(name)}':\\n\\s+specifier: .*\\n\\s+version: ([^\\s(]+)`))?.[1];
    if (!version) problems.push(`${name} was not found in web/pnpm-lock.yaml`);
    else if (majorMinor(version) !== majorMinor(crate)) problems.push(`${name} ${version}`);
  }
  if (problems.length > 0) {
    return { ok: false, message: `Tauri packages must share the major.minor of the tauri crate ${crate}: ${problems.join(", ")}. Bump the Rust and web halves together.` };
  }
  return { ok: true, message: `Tauri packages aligned on ${majorMinor(crate)} (tauri ${crate}).` };
}

const NOTE_SECTIONS = ["Breaking changes", "Features", "Fixes", "Dependencies", "Documentation", "Other"];

function noteSection(parsed, body) {
  if (parsed?.breaking || /^BREAKING[ -]CHANGE:/m.test(lf(body))) return "Breaking changes";
  if (!parsed) return "Other";
  const { type, scope } = parsed;
  if (["chore", "build"].includes(type) && ["deps", "deps-dev"].includes(scope)) return "Dependencies";
  return { feat: "Features", fix: "Fixes", docs: "Documentation" }[type] ?? "Other";
}

/**
 * The tag release notes start from. `earlierTags` are the `v*` tags before
 * `tag`, newest first. A stable release skips the candidates before it.
 */
export function previousReleaseTag(tag, earlierTags) {
  const stable = !tag.includes("-");
  return earlierTags.find((earlier) => TAG.test(earlier) && (!stable || !earlier.includes("-")));
}

/**
 * Draft release notes from the squash-merged titles since the previous tag.
 * `commits` are `{ subject, body }`, newest or oldest first as given.
 */
export function releaseNotes(commits, { repository, previousTag, tag }) {
  const sections = Object.fromEntries(NOTE_SECTIONS.map((name) => [name, []]));
  for (const { subject, body } of commits) {
    const [, title, pr] = String(subject).trim().match(/^(.*?)(?:\s*\(#(\d+)\))?$/);
    const parsed = parseTitle(title);
    if (parsed?.type === "chore" && parsed.scope === "release") continue;
    const section = noteSection(parsed, body);
    const text = !parsed || section === "Other" ? title : `${parsed.scope ? `**${parsed.scope}:** ` : ""}${parsed.description}`;
    sections[section].push(`- ${text}${pr ? ` ([#${pr}](https://github.com/${repository}/pull/${pr}))` : ""}`);
  }
  const changelog = previousTag
    ? `**Full changelog:** https://github.com/${repository}/compare/${previousTag}...${tag}`
    : `**Full history:** https://github.com/${repository}/commits/${tag}`;
  const filled = NOTE_SECTIONS.filter((name) => sections[name].length > 0);
  if (filled.length === 0) return `No changes${previousTag ? ` since ${previousTag}` : ""}.\n\n${changelog}\n`;
  return `${filled.map((name) => `### ${name}\n\n${sections[name].join("\n")}\n`).join("\n")}\n${changelog}\n`;
}

// What each installer is for, in plain words, next to its file name (`Oxide_<version>_<os>_<arch>.<ext>`).
const DOWNLOADS = [
  [/_macos_arm64\.dmg$/, "macOS (Apple Silicon)", "Disk image"],
  [/_windows_x64\.exe$/, "Windows (Intel/AMD, 64-bit)", "Installer"],
  [/_windows_arm64\.exe$/, "Windows (Arm)", "Installer"],
  [/_linux_x64\.AppImage$/, "Linux (Intel/AMD, 64-bit)", "AppImage, runs on any distribution"],
  [/_linux_arm64\.AppImage$/, "Linux (Arm)", "AppImage, runs on any distribution"],
  [/_linux_x64\.deb$/, "Linux (Intel/AMD, 64-bit): Debian, Ubuntu", ".deb package"],
  [/_linux_arm64\.deb$/, "Linux (Arm): Debian, Ubuntu", ".deb package"],
  [/_linux_x64\.rpm$/, "Linux (Intel/AMD, 64-bit): Fedora, RHEL, openSUSE", ".rpm package"],
  [/_linux_arm64\.rpm$/, "Linux (Arm): Fedora, RHEL, openSUSE", ".rpm package"],
];

/** A "Downloads" section that tells which file is for which platform. Unknown files are left out. */
export function downloadsSection(artifactNames) {
  const rows = [];
  for (const [pattern, platform, kind] of DOWNLOADS) {
    for (const name of artifactNames.filter((candidate) => pattern.test(candidate)).sort()) rows.push(`| ${platform} | ${kind} | \`${name}\` |`);
  }
  if (rows.length === 0) return "";
  return `### Downloads\n\n| Platform | Format | File |\n| --- | --- | --- |\n${rows.join("\n")}\n`;
}

/**
 * The in-app update packages (ADR-0021). Windows and Linux update from the installer
 * they already ship (the NSIS installer, the AppImage); macOS needs the `.app` archive.
 * `key` is the platform name of Tauri's updater feed; `asset` names the package of a version.
 */
export const UPDATER_PLATFORMS = [
  { key: "darwin-aarch64", asset: (version) => `Oxide_${version}_macos_arm64.app.tar.gz` },
  { key: "windows-x86_64", asset: (version) => `Oxide_${version}_windows_x64.exe` },
  { key: "windows-aarch64", asset: (version) => `Oxide_${version}_windows_arm64.exe` },
  { key: "linux-x86_64", asset: (version) => `Oxide_${version}_linux_x64.AppImage` },
  { key: "linux-aarch64", asset: (version) => `Oxide_${version}_linux_arm64.AppImage` },
];

/** Where a release's assets are served; the update feed points here and the check accepts nothing else. */
function releaseAssetBase(repository, tag) {
  return `https://github.com/${repository}/releases/download/${tag}/`;
}

/**
 * The `latest.json` of a release. `signatures` maps each package name to the contents of its
 * `.sig` file. A missing or blank signature throws: an unsigned package would be refused by every install.
 */
export function buildUpdateFeed({ tag, repository, signatures, pubDate }) {
  const version = String(tag ?? "").match(TAG)?.[1];
  if (!version) throw new Error(`The tag "${tag}" is not a release tag (vX.Y.Z).`);
  const platforms = {};
  for (const { key, asset } of UPDATER_PLATFORMS) {
    const name = asset(version);
    const signature = String(signatures?.[name] ?? "").trim();
    if (!signature) throw new Error(`The signature of ${name} is missing or empty.`);
    platforms[key] = { url: `${releaseAssetBase(repository, tag)}${name}`, signature };
  }
  return { version, notes: `https://github.com/${repository}/releases/tag/${tag}`, pub_date: pubDate, platforms };
}

/**
 * Whether `signature` (a package's `.sig` file, as `tauri signer sign` writes it) is a valid minisign
 * signature of `data` by `pubkey` (`plugins.updater.pubkey` in tauri.conf.json), checked the way the
 * updater plugin checks it: the package signature and the signature over its trusted comment. A release
 * signed with any other key would be refused by every install, so the feed is never written for it.
 */
export function checkUpdaterSignature({ pubkey, signature, data, name }) {
  const refuse = (why) => ({ ok: false, message: `The updater signature of ${name} ${why}` });
  // Each file is base64 of the minisign text; its second line is base64 of the binary key or signature.
  const lines = (base64) => Buffer.from(String(base64 ?? "").trim(), "base64").toString("utf8").split("\n");
  const key = Buffer.from(lines(pubkey)[1] ?? "", "base64");
  const [, packed = "", trusted = "", global = ""] = lines(signature);
  const sig = Buffer.from(packed, "base64");
  const globalSig = Buffer.from(global, "base64");
  if (key.length !== 42 || key.subarray(0, 2).toString("latin1") !== "Ed") return refuse("cannot be checked: the public key is malformed.");
  const algorithm = sig.subarray(0, 2).toString("latin1");
  if (sig.length !== 74 || !["Ed", "ED"].includes(algorithm) || !trusted.startsWith("trusted comment: ") || globalSig.length !== 64) {
    return refuse("is malformed.");
  }
  const keyId = (bytes) => Buffer.from(bytes.subarray(2, 10)).reverse().toString("hex").toUpperCase();
  if (!key.subarray(2, 10).equals(sig.subarray(2, 10))) {
    return refuse(`was made by key ${keyId(sig)}, not by the app's updater key ${keyId(key)}.`);
  }
  const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.subarray(10).toString("base64url") }, format: "jwk" });
  const message = algorithm === "ED" ? createHash("blake2b512").update(data).digest() : data;
  if (!verify(null, message, publicKey, sig.subarray(10))) return refuse("does not match the package.");
  const comment = Buffer.from(trusted.slice("trusted comment: ".length), "utf8");
  if (!verify(null, Buffer.concat([sig.subarray(10), comment]), publicKey, globalSig)) return refuse("has a changed trusted comment.");
  return { ok: true, message: `The updater signature of ${name} matches the app's updater key ${keyId(key)}.` };
}

/** Whether a release asset exists only for the updater, so notes and the Downloads table leave it out. */
export function isUpdaterOnlyAsset(name) {
  return /\.sig$/.test(name) || /\.app\.tar\.gz$/.test(name) || name === "latest.json";
}

/** The `sha256sum` listing of a release without the updater-only assets, for the notes. */
export function releaseChecksums(listing) {
  /** The file name of a `sha256sum` line: the last field, without the binary-mode asterisk. */
  const assetOf = (line) => line.trim().split(/\s+\*?/).pop();
  return lf(listing).split("\n")
    .filter((line) => line.trim() && !isUpdaterOnlyAsset(assetOf(line)) && !isRepositoryAsset(assetOf(line)))
    .map((line) => `${line}\n`).join("");
}

/** Every package URL in a feed, for the reachability check. */
export function feedUrls(feed) {
  return Object.values(feed?.platforms ?? {}).map((entry) => entry.url);
}

function feedProblems(feed, label, { repository, tag }) {
  if (!feed || typeof feed !== "object") return [`the ${label} is missing or not JSON`];
  const problems = [];
  const entries = Object.entries(feed.platforms ?? {});
  if (entries.length === 0) problems.push(`the ${label} has no platforms`);
  for (const [key, entry] of entries) {
    if (!String(entry?.signature ?? "").trim()) problems.push(`the ${label} has no signature for ${key}`);
    if (!String(entry?.url ?? "").startsWith(releaseAssetBase(repository, tag))) problems.push(`the ${label} points ${key} outside ${tag}'s assets`);
  }
  return problems;
}

/**
 * The post-publish check of both feeds. The pre-release feed always names the published
 * release. The stable feed names it only when it is stable, and must never name a pre-release.
 */
export function checkPublishedFeeds({ tag, stable, prerelease, repository = "getoxide/oxide" }) {
  const version = String(tag ?? "").match(TAG)?.[1];
  if (!version) return { ok: false, message: `The tag "${tag}" is not a release tag.` };
  const isStable = !version.includes("-");
  const problems = [];
  if (prerelease?.version !== version) problems.push(`the pre-release feed names ${prerelease?.version ?? "nothing"}, not ${version}`);
  problems.push(...feedProblems(prerelease, "pre-release feed", { repository, tag }));
  if (isStable) {
    if (stable?.version !== version) problems.push(`the stable feed names ${stable?.version ?? "nothing"}, not ${version}`);
    problems.push(...feedProblems(stable, "stable feed", { repository, tag }));
  } else if (stable?.version === version) {
    problems.push(`the stable feed names the pre-release ${version}`);
  }
  if (problems.length > 0) return { ok: false, message: `Feeds are wrong for ${tag}: ${problems.join("; ")}.` };
  return { ok: true, message: `Both feeds are right for ${tag}.` };
}

/**
 * The Linux package repositories (ADR-0021). APT is a flat repository made of release assets; DNF
 * keeps only its metadata on the update site, and its packages are the release's own assets.
 * One OpenPGP key signs the APT `InRelease`, every `.rpm` and the DNF `repomd.xml`.
 */
export const REPOSITORY_SECRETS = ["OXIDE_REPOSITORY_SIGNING_KEY", "OXIDE_REPOSITORY_SIGNING_KEY_PASSPHRASE"];
/** The signed APT index, as release assets. One index lists the amd64 and arm64 packages. */
export const APT_REPOSITORY_FILES = ["InRelease", "Release", "Packages"];
/** The public half of the repository key (binary for apt's `signed-by`, armored for rpm and dnf). */
export const REPOSITORY_KEY_FILES = ["oxide-repository.gpg", "oxide-repository.asc"];
const REPOSITORY_ARCHES = [
  { asset: "x64", deb: "amd64", rpm: "x86_64" },
  { asset: "arm64", deb: "arm64", rpm: "aarch64" },
];

/**
 * What a release contributes to the repositories. Throws when a package is missing: a repository
 * that lacks an architecture would make that architecture's `apt upgrade` silently stop.
 * Pre-releases are signed too (a draft's assets rehearse the repositories) but never reach DNF:
 * GitHub's "latest" link already keeps them out of APT, and `dnf.publish` keeps them off the update site.
 */
export function repositoryPlan({ tag, repository, assetNames }) {
  const version = String(tag ?? "").match(TAG)?.[1];
  if (!version) throw new Error(`The tag "${tag}" is not a release tag (vX.Y.Z).`);
  const pick = (extension, field) => REPOSITORY_ARCHES.map((arch) => {
    const name = `Oxide_${version}_linux_${arch.asset}.${extension}`;
    if (!assetNames.includes(name)) throw new Error(`The release has no ${name}; the repositories need one .${extension} per architecture.`);
    return { name, arch: arch[field] };
  });
  const stable = !version.includes("-");
  return {
    version,
    stable,
    debs: pick("deb", "deb"),
    rpms: pick("rpm", "rpm"),
    aptFiles: [...APT_REPOSITORY_FILES, ...REPOSITORY_KEY_FILES],
    dnf: { publish: stable, baseUrl: releaseAssetBase(repository, tag), sitePath: "rpm" },
  };
}

/** Whether a release asset exists only for the repositories, so the notes' checksum list leaves it out. */
export function isRepositoryAsset(name) {
  return APT_REPOSITORY_FILES.includes(name) || REPOSITORY_KEY_FILES.includes(name);
}

/**
 * The APT `Release` file of the flat repository. It pins `Packages` by hash and size, and the
 * signed `InRelease` carries it, so a tampered index or package is refused. `date` is RFC 2822 in UTC.
 */
export function aptReleaseFile({ packagesText, date }) {
  const bytes = Buffer.from(packagesText, "utf8");
  return [
    "Origin: Oxide",
    "Label: Oxide",
    "Suite: stable",
    `Date: ${date}`,
    `Architectures: ${REPOSITORY_ARCHES.map(({ deb }) => deb).join(" ")}`,
    "Description: Oxide Linux packages",
    "SHA256:",
    ` ${sha256(bytes)} ${bytes.length} Packages`,
    "",
  ].join("\n");
}

/** The update site, which serves the DNF metadata and the key (GitHub Pages from the `updates` branch). */
export const UPDATE_SITE = "https://getoxide.github.io/oxide/";

/** Where the documented setup, and the packages' maintainer scripts, put Oxide's APT source, its key and the DNF repo file. */
export const APT_SOURCE_PATH = "/etc/apt/sources.list.d/oxide.list";
export const APT_KEYRING_PATH = "/usr/share/keyrings/oxide.gpg";
export const DNF_REPO_PATH = "/etc/yum.repos.d/oxide.repo";

/** The flat APT repository: the assets of the latest release, which GitHub never resolves to a draft or a pre-release. */
const LATEST_ASSET_BASE = "https://github.com/getoxide/oxide/releases/latest/download/";

/** The one line of the APT source: the flat repository of the latest release, signed by the Oxide keyring only. */
export function aptSourceFile() {
  return `deb [signed-by=${APT_KEYRING_PATH}] ${LATEST_ASSET_BASE} ./\n`;
}

/** The `.repo` file users add to `/etc/yum.repos.d/`: both package and metadata signatures are checked. */
export function dnfRepoFile() {
  return [
    "[oxide]",
    "name=Oxide",
    `baseurl=${UPDATE_SITE}rpm/`,
    "enabled=1",
    "gpgcheck=1",
    "repo_gpgcheck=1",
    `gpgkey=${UPDATE_SITE}rpm/${REPOSITORY_KEY_FILES[1]}`,
    "metadata_expire=6h",
    "skip_if_unavailable=1",
    "",
  ].join("\n");
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** Index entries of an APT `Packages` file: one stanza per package. */
function aptStanzas(text) {
  return lf(text).split(/\n\s*\n/).filter((block) => block.trim()).map((block) => Object.fromEntries(
    block.split("\n").map((line) => line.match(/^([\w-]+):\s*(.*)$/)).filter(Boolean).map(([, key, value]) => [key, value.trim()]),
  ));
}

/**
 * The post-publish check of the APT index: `Release` pins `Packages`, and `Packages` names the
 * package of each architecture with the hash of the file users download. (The `InRelease`
 * signature is checked with gpgv in the workflow.) `hashes` maps asset names to their SHA-256.
 */
export function checkAptRepository({ plan, releaseText, packagesText, hashes }) {
  const problems = [];
  const pinned = lf(releaseText).match(/^ ([0-9a-f]{64}) (\d+) Packages$/m);
  if (!pinned || pinned[1] !== sha256(Buffer.from(packagesText, "utf8")) || Number(pinned[2]) !== Buffer.byteLength(packagesText, "utf8")) {
    problems.push("the Release file does not pin this Packages file");
  }
  const stanzas = aptStanzas(packagesText);
  for (const { name, arch } of plan.debs) {
    const entry = stanzas.find((stanza) => stanza.Architecture === arch);
    if (!entry) problems.push(`Packages has no ${arch} package`);
    else if (entry.Package !== "oxide") problems.push(`the ${arch} package is named ${entry.Package}, not oxide`);
    else if (entry.Filename?.replace(/^\.\//, "") !== name) problems.push(`the ${arch} package points at ${entry.Filename}, not ${name}`);
    else if (entry.SHA256 !== hashes?.[name]) problems.push(`the hash of ${name} in Packages is not the published file's`);
  }
  if (problems.length > 0) return { ok: false, message: `The APT repository of v${plan.version} is wrong: ${problems.join("; ")}.` };
  return { ok: true, message: `The APT repository of v${plan.version} pins its index and lists amd64 and arm64.` };
}

/**
 * The post-publish check of the DNF metadata: `repomd.xml` pins `primary.xml.gz` (`primarySha256` is
 * the hash of the file fetched), and `primary` points each package at the release's own asset with its hash.
 * (The `repomd.xml` signature is checked with gpg in the workflow.)
 */
export function checkDnfRepository({ plan, repomd, primaryXml, primarySha256, hashes }) {
  const problems = [];
  const primaryData = String(repomd).match(/<data type="primary">[\s\S]*?<\/data>/)?.[0];
  const pinnedHash = primaryData?.match(/<checksum type="sha256">([^<]+)<\/checksum>/)?.[1];
  if (!pinnedHash || pinnedHash !== primarySha256) problems.push("repomd.xml does not pin this primary file");
  const entries = [...String(primaryXml).matchAll(/<package type="rpm">[\s\S]*?<\/package>/g)].map(([block]) => ({
    arch: block.match(/<arch>([^<]*)<\/arch>/)?.[1],
    sha: block.match(/<checksum type="sha256"[^>]*>([^<]*)<\/checksum>/)?.[1],
    base: block.match(/<location[^>]*xml:base="([^"]*)"/)?.[1],
    href: block.match(/<location[^>]*href="([^"]*)"/)?.[1],
    name: block.match(/<name>([^<]*)<\/name>/)?.[1],
  }));
  for (const { name, arch } of plan.rpms) {
    const entry = entries.find((candidate) => candidate.href === name && candidate.arch === arch);
    if (!entry) problems.push(`primary has no ${arch} package at ${name}`);
    else if (entry.name !== "oxide") problems.push(`${name} is named ${entry.name}, not oxide`);
    else if (entry.base !== plan.dnf.baseUrl) problems.push(`${name} is located at ${entry.base ?? "no base"}, not the release's assets`);
    else if (entry.sha !== hashes?.[name]) problems.push(`the hash of ${name} in primary is not the published file's`);
  }
  if (problems.length > 0) return { ok: false, message: `The DNF repository of v${plan.version} is wrong: ${problems.join("; ")}.` };
  return { ok: true, message: `The DNF repository of v${plan.version} pins its primary file and points both architectures at the release's assets.` };
}

/** The names among `names` that `env` does not set to a non-blank value. */
export function missingSecrets(env, names) {
  return names.filter((name) => !String(env?.[name] ?? "").trim());
}

/**
 * The names among `names` whose presence flag `HAS_<name>` is not exactly "true". The build jobs test a
 * secret with the expression `secrets.X != ''`, so no key's value ever reaches their environment.
 */
export function missingPresent(env, names) {
  return names.filter((name) => env?.[`HAS_${name}`] !== "true");
}

// Packages that break when moved alone, or whose bumps change generated bindings.
const MANUAL_GROUPS = new Set(["tauri", "specta"]);

function parseVersion(version) {
  const match = String(version ?? "").match(/^v?(\d+)\.(\d+)\.\d+/);
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : undefined;
}

// Why an update needs a human, or undefined when it is low-risk.
function riskOf({ dependencyName: name, updateType, prevVersion, newVersion, dependencyGroup }) {
  if (MANUAL_GROUPS.has(dependencyGroup)) return `${name} is in the ${dependencyGroup} group`;
  const previous = parseVersion(prevVersion);
  if (!previous || !parseVersion(newVersion)) return `${name} has unreadable versions (${prevVersion ?? "?"} → ${newVersion ?? "?"})`;
  switch (updateType) {
    case "version-update:semver-patch":
      return previous.major === 0 && previous.minor === 0 ? `${name} ${prevVersion} is 0.0.x, so a patch may break` : undefined;
    case "version-update:semver-minor":
      return previous.major === 0 ? `${name} ${prevVersion} is 0.x, so a minor may break` : undefined;
    case "version-update:semver-major":
      return `${name} is a major update`;
    default:
      return `${name} has an unknown update type "${updateType ?? ""}"`;
  }
}

/**
 * Whether a Dependabot PR may auto-merge once the gate passes. The input is
 * dependabot/fetch-metadata's `updated-dependencies-json`.
 */
export function dependabotDecision(updatedDependencies) {
  if (!Array.isArray(updatedDependencies) || updatedDependencies.length === 0) {
    return { decision: "manual", reason: "no updated dependencies could be read" };
  }
  const risks = updatedDependencies.map(riskOf).filter(Boolean);
  if (risks.length > 0) return { decision: "manual", reason: risks.join("; ") };
  return { decision: "auto", reason: "every update is a patch, or a minor of a package at 1.0 or later" };
}

// Node platform names and how the plan names them.
const OS_NAMES = { darwin: "macOS", win32: "Windows", linux: "Linux" };
const EVERY_OS = Object.keys(OS_NAMES);
/** The Rust target the local Windows check compiles for. */
export const WINDOWS_TARGET = "x86_64-pc-windows-msvc";
const CI_JOB_ONLY = (job, what) => `CI only: the ${job} job ${what}`;

/**
 * The advisory scans: run daily by advisories.yml (which tracks findings in an
 * issue) and as a gate before a release builds. Not PR checks: a new advisory
 * against an untouched dependency would block unrelated work.
 */
export const ADVISORY_SCANS = [
  { id: "cargo-deny-advisories", command: ["cargo", "deny", "--locked", "check", "advisories"] },
  { id: "pnpm-audit", command: ["pnpm", "--dir", "web", "audit", "--prod", "--audit-level", "high"] },
];

// What the PR lanes run, in the order the local runner runs it. A check with
// `ci` instead of a command needs a tool or context that only CI has.
const CHECKS = [
  { id: "web-install", tiers: ["pr"], platforms: EVERY_OS, command: ["pnpm", "--dir", "web", "install", "--frozen-lockfile"] },
  { id: "rust-fmt", tiers: ["fast", "pr"], platforms: EVERY_OS, command: ["cargo", "fmt", "--all", "--check"] },
  // ADR-0016: Git and gh start only in the hardened builders. Pure Node, so it is cheap enough for `fast`.
  { id: "process-builders", tiers: ["fast", "pr"], platforms: EVERY_OS, command: ["node", "tools/checks/process-builders.mjs"] },
  // ADR-0019: OS-specific code lives in crates/oxide-platform. Pure Node, so it is cheap enough for `fast`.
  { id: "platform-layer", tiers: ["fast", "pr"], platforms: EVERY_OS, command: ["node", "tools/checks/platform-layer.mjs"] },
  { id: "web-lint", tiers: ["fast", "pr"], platforms: EVERY_OS, command: ["pnpm", "--dir", "web", "lint"] },
  { id: "web-typecheck", tiers: ["fast", "pr"], platforms: EVERY_OS, command: ["pnpm", "--dir", "web", "typecheck"] },
  { id: "web-test", tiers: ["pr"], platforms: EVERY_OS, command: ["pnpm", "--dir", "web", "test"] },
  { id: "web-build", tiers: ["pr"], platforms: EVERY_OS, command: ["pnpm", "--dir", "web", "build"] },
  { id: "tooling-tests", tiers: ["pr"], platforms: EVERY_OS, command: ["node", "--test", "tools/**/*.test.mjs"] },
  { id: "tauri-alignment", tiers: ["pr"], platforms: EVERY_OS, command: ["node", "tools/ci/cli.mjs", "tauri-alignment"] },
  { id: "clippy", tiers: ["pr"], platforms: EVERY_OS, command: ["cargo", "clippy", "--locked", "--workspace", "--all-targets", "--", "-D", "warnings"] },
  { id: "rust-test", tiers: ["pr"], platforms: EVERY_OS, command: ["cargo", "nextest", "run", "--locked", "--workspace"] },
  // The Rust tests regenerate the bindings; a diff means they were not committed.
  { id: "bindings", tiers: ["pr"], platforms: EVERY_OS, command: ["git", "diff", "--exit-code", "web/src/bindings.ts"] },
  { id: "bundle-macos", tiers: ["pr"], platforms: ["darwin"], command: ["web/node_modules/.bin/tauri", "build", "--ci", "--bundles", "app,dmg"] },
  { id: "bundle-windows", tiers: ["pr"], platforms: ["win32"], command: ["web/node_modules/.bin/tauri.cmd", "build", "--ci", "--bundles", "nsis"] },
  { id: "bundle-linux", tiers: ["pr"], platforms: ["linux"], command: ["web/node_modules/.bin/tauri", "build", "--ci", "--bundles", "appimage,deb,rpm"] },
  { id: "cargo-deny", tiers: ["pr"], platforms: EVERY_OS, ci: CI_JOB_ONLY("supply-chain", "installs cargo-deny and checks bans, licences and sources") },
  { id: "dependency-review", tiers: ["pr"], platforms: EVERY_OS, ci: CI_JOB_ONLY("supply-chain", "asks GitHub to review dependencies the PR adds") },
  { id: "actionlint", tiers: ["pr"], platforms: EVERY_OS, ci: CI_JOB_ONLY("automation", "installs actionlint") },
  { id: "zizmor", tiers: ["pr"], platforms: EVERY_OS, ci: CI_JOB_ONLY("automation", "installs zizmor") },
  { id: "schemas", tiers: ["pr"], platforms: EVERY_OS, ci: CI_JOB_ONLY("automation", "installs check-jsonschema") },
  { id: "pr-title", tiers: ["pr"], platforms: EVERY_OS, ci: CI_JOB_ONLY("pr-title", "checks the pull request title") },
  // Local only (`node tools/check.mjs windows`): the CI Windows lane runs the real Clippy. This
  // cross-compiles on macOS and Linux with cargo-xwin, which fetches the Windows SDK headers that
  // C dependencies such as `ring` need. `oxide-app` is left out: its Tauri build script needs
  // `llvm-rc`, which only a full LLVM install provides.
  {
    id: "windows-clippy",
    tiers: ["windows"],
    platforms: ["darwin", "linux"],
    command: ["cargo", "xwin", "clippy", "--locked", "--target", WINDOWS_TARGET, "--workspace", "--exclude", "oxide-app", "--all-targets", "--", "-D", "warnings"],
  },
];

function skipReason(check, platform) {
  if (check.ci) return check.ci;
  if (check.platforms.includes(platform)) return undefined;
  const where = check.platforms.map((name) => OS_NAMES[name]).join(" and ");
  return `runs only on ${where}`;
}

/**
 * The commands the PR lanes run on this OS, in order, and what the local
 * runner can't run here and why. `fast` is the pre-commit subset; `windows` is the Windows
 * cross-check for contributors on another OS.
 */
export function localPlan(platform, tier = "pr") {
  if (!Object.hasOwn(OS_NAMES, platform)) throw new Error(`Unsupported platform "${platform}".`);
  if (!["fast", "pr", "windows"].includes(tier)) throw new Error(`Unknown tier "${tier}": use fast, pr or windows.`);
  const plan = { run: [], skipped: [] };
  for (const check of CHECKS.filter(({ tiers }) => tiers.includes(tier))) {
    const reason = skipReason(check, platform);
    if (reason) plan.skipped.push({ id: check.id, reason });
    else plan.run.push({ id: check.id, command: check.command });
  }
  return plan;
}

/** A command as one line to copy into a shell. Quoting keeps glob patterns for the program to expand. */
export function commandLine(command) {
  return command.map((part) => (/[\s*?]/.test(part) ? `"${part}"` : part)).join(" ");
}
