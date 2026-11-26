# DevOps guide

How Oxide is checked, built and released, and why each piece exists. The structural decisions are recorded in [ADR-0008](adr/0008-continuous-delivery-with-human-published-releases.md); this guide is the operating manual.

Oxide has **CI** (every pull request and every `main` commit is verified) and **continuous delivery**: every `main` commit is proven releasable, but only a Release Manager turns one into an official release, and publishing stays a human click. There is no continuous deployment.

- [The pipeline](#the-pipeline)
- [Roles and how they are enforced](#roles-and-how-they-are-enforced)
- [CI jobs](#ci-jobs)
- [Lanes](#lanes)
- [Test layers](#test-layers)
- [Release workflows](#release-workflows)
- [Scheduled and automatic workflows](#scheduled-and-automatic-workflows)
- [Release runbook](#release-runbook)
- [Secrets and the fork/PR threat model](#secrets-and-the-forkpr-threat-model)
- [Pinned versions Dependabot can't bump](#pinned-versions-dependabot-cant-bump)
- [What to do with a flaky test](#what-to-do-with-a-flaky-test)
- [GitHub settings](#github-settings)

## The pipeline

```
pull_request ──► CI ─ changes ─┬─ web ─────────────── (Linux)
                               ├─ rust-fmt ────────── (Linux)
                               ├─ rust (macos)        Clippy + nextest + bindings
                               ├─ rust (windows)      Clippy + nextest + bindings
                               ├─ rust (linux)        Clippy + nextest + bindings
                               ├─ supply-chain ────── (Linux) deny, alignment, dependency review
                               ├─ automation ──────── (Linux) actionlint, zizmor, schemas, tooling tests
                               ├─ pr-title ────────── (Linux)
                               ├─ bundle (macos)      only when packaging inputs change
                               ├─ bundle (windows)    only when packaging inputs change
                               ├─ bundle (windows-arm64), (linux), (linux-arm64)   likewise
                               └─► gate   ◄── the ONE required check

push main / release/** ──► CI, every lane forced on (incl. every bundle) ──► gate on that commit

tag vX.Y.Z  (immutable once pushed)
   └─► Release ─ verify ─► [approval: environment `release`] ─► build macOS, Windows (x64, arm64) and Linux (x64, arm64) ─► [approval] repositories ─► publish DRAFT
                              (refuses a missing update or repository key)                                          (signs .rpm, APT index, DNF metadata)   (dmg, exe, AppImage, deb, signed rpm, updater packages, latest.json,
                                                                                                                                                              APT InRelease/Packages/key, notes, checksums; metadata/SBOM as run artifact)
Release Manager reviews and clicks Publish ──► immutable release ──► Verify release (checksums and attestations)
                                                                  ├─► update feeds: prerelease.json on the `updates` branch (GitHub Pages), both feeds checked
                                                                  └─► Linux repositories: DNF metadata to `rpm/` on the `updates` branch (stable only), APT and DNF checked

daily  ──► Advisories (RustSec + pnpm audit) ──► one tracking issue per ecosystem on failure
weekly ──► Dependabot ──► auto-merge low-risk / `manual-review`
```

Every decision the pipeline makes (which lanes a change needs, whether the gate passes, whether a PR title is valid, whether a tag matches the versions, the release notes, the Dependabot verdict, the Downloads table) is a pure function in [`tools/ci/policy.mjs`](../tools/ci/policy.mjs) with tests in `policy.test.mjs`. The workflows only gather inputs and act on the answers through [`tools/ci/cli.mjs`](../tools/ci/cli.mjs). YAML can't be unit-tested, so logic doesn't live there. To change a decision, change it test-first in `policy.test.mjs`.

## Roles and how they are enforced

**Release Managers** are `cavallinilorenzo` and `itsmrma`. They alone may approve a release build and publish a release. Everything below enforces that one rule from a different side.

| Control | What it does |
| --- | --- |
| `release` environment | Required reviewers are exactly the two Release Managers. Any signing secret would be readable only by jobs of this environment, so no release is built, and no key is touched, until one of them approves. Deployment refs are limited to `v*` tags, so a workflow edited on a branch can't request the secrets. |
| `release tags` ruleset | `refs/tags/v*` can't be updated or deleted by anyone but the repository admin. Creation stays open to write collaborators. |
| `main protection` ruleset | PR required, required check `gate`, squash only, no force-push, no deletion. The same for `release/**`. |
| `verify` job | Refuses a tag that isn't on `main` or `release/*`, doesn't match the three manifests, or whose commit has no green `gate`. |
| Draft releases | The pipeline never publishes. A Release Manager reads the draft and clicks Publish. |
| Immutable releases | A published release's tag and assets can't change. |

**Why the tag ruleset can't limit who creates a tag.** Oxide lives in a personal repository: there is only the owner (admin) and collaborators (write), no Maintain role, and ruleset bypass lists take roles, not users. So tag creation can't be restricted to exactly two people. The `release` environment is the binding control: a tag pushed by anyone else just waits for approval that never comes. Moving to an organization would add a Maintain role. Revisit if more collaborators get write access.

**Why self-approval is allowed.** With two Release Managers, strict four-eyes would block every release while one is away. The approval is still a deliberate second act: the approver sees `verify`'s result before the keys unlock.

## CI jobs

The workflow is [`.github/workflows/ci.yml`](../.github/workflows/ci.yml). Triggers: `pull_request`, `push` to `main` and `release/**`, and manual dispatch. The token is read-only by default and each job asks for more only if it needs it. Concurrency is per ref: a new push cancels the superseded PR run, but a `main` run always finishes. Every job has a timeout sized to its normal duration. Runners are pinned to `ubuntu-24.04`, `macos-15` (Apple Silicon) and `windows-2025`; the shared build also uses `windows-11-arm`, `ubuntu-22.04` and `ubuntu-22.04-arm` (the native Arm runners are free for public repositories).

In the tables, **Blocking** means a red job turns `gate` red. Every job below blocks.

The local runner is `node tools/check.mjs` (everything the PR lanes run on this OS) or `node tools/check.mjs fast` (rustfmt, ESLint, TypeScript). Where a job has no individual command, the entry says so.

Local compilation reuses a persistent Cargo target across runs, with incremental
development builds and no debug information. It warns above 12 GiB; an explicit
`OXIDE_BUILD_BUDGET_GIB` enforces a hard limit. See CONTRIBUTING's "Local build
disk usage" for cache maintenance and output locations. CI keeps its existing
`CARGO_INCREMENTAL=0` setting and release builds keep their existing profiles.

### `changes`

- **What:** lists the PR's changed files through the API and calls `lanesFor`, which decides which lanes run.
- **Why:** a docs-only PR shouldn't wait for a Windows build.
- **When / where:** every run, Linux.
- **Blocking:** yes, indirectly. It fails open: if the list is missing, truncated or has a path no rule knows, every lane runs.
- **Local:** `node tools/ci/cli.mjs lanes <file-with-changed-paths>`.

### `web`

- **What:** frozen pnpm install, TypeScript, ESLint, Vitest, production `vite build`.
- **Why:** the checks are platform-independent (jsdom gives the same answer everywhere), so they run once on Linux and don't queue behind scarce macOS runners. The production build catches Vite, Monaco and Shiki breakage before the bundle job does.
- **When / where:** `web` lane, Linux.
- **Local:** `pnpm --dir web install --frozen-lockfile`, then `pnpm --dir web typecheck`, `lint`, `test`, `build`. All are part of `node tools/check.mjs`.

### `rust-fmt`

- **What:** `cargo fmt --all --check`, then `node tools/checks/process-builders.mjs`, which fails on a `Command::new` of `git` or `gh` outside the hardened builders (`git_command.rs`, `github.rs`; integration tests under `tests/` are exempt). See [ADR-0016](adr/0016-security-boundaries.md). Then `node tools/checks/platform-layer.mjs`, which fails when OS-specific conditional compilation or an OS-only API appears outside `crates/oxide-platform` (and `tests/support/`), compared with the baseline in `tools/checks/platform-layer-baseline.json`, when the macOS, Linux and Windows implementations of the platform layer stop offering the same items, and when another crate depends on an OS binding crate. See [ADR-0019](adr/0019-platform-layer.md).
- **Why:** both are mechanical and fail in seconds without waiting for a compile. The builder check keeps a repository's own configuration from running programs on Oxide's behalf.
- **When / where:** `rust` lane, Linux.
- **Local:** `cargo fmt --all --check`, `node tools/checks/process-builders.mjs` and `node tools/checks/platform-layer.mjs` (all also in `fast`). To check the Windows build from macOS or Linux, run `node tools/check.mjs windows` (needs `cargo install --locked cargo-xwin` and LLVM's `llvm-lib`, `brew install llvm`; it leaves out `oxide-app`, whose build script needs `llvm-rc`). The CI Windows lane stays the authority.

### `rust (macos)`, `rust (windows)` and `rust (linux)`

- **What:** Clippy (`--locked --workspace --all-targets -D warnings`), then `cargo nextest run --locked --workspace --profile ci`, then a check that the generated `web/src/bindings.ts` is committed. Failures list flaky tests in the job summary and upload JUnit.
- **Why:** all three are shipped platforms, and `cfg`-specific code (Metal and objc2 on macOS; Job Objects, the registry and the PowerShell PTY on Windows; the Unix PTY and `xdg-open` paths on Linux) only compiles on its own OS. The Linux job installs WebKitGTK and the other native libraries through the shared `setup-rust` action. The Arm builds are not run through Clippy and the tests: the Rust code does not differ by architecture, and the bundle jobs prove they compile. Windows is the critical path, so these jobs install no Node and build no frontend: debug builds don't embed `web/dist`.
- **When / where:** `rust` lane, macOS, Windows and Linux.
- **Local:** `node tools/check.mjs` runs Clippy, the tests and the bindings check on your OS. It needs `cargo install --locked cargo-nextest`. The local run uses nextest's default profile, with no retries and no timeouts. Stale bindings: `cargo test -p oxide-app --test bindings_and_capabilities`, then commit `web/src/bindings.ts`.

### `supply-chain`

- **What:** the Tauri alignment check (the `tauri` crate and `@tauri-apps/*` packages must share a `major.minor`); `cargo deny check bans licenses sources` against the macOS, Windows (x64, arm64) and Linux (x64, arm64) graphs, and against the Vulkan and CUDA worker lockfiles (they ship but are outside the workspace), using [`deny.toml`](../deny.toml); on PRs, GitHub's dependency review (`fail-on-severity: high`, licence allowlist, with a per-package exception for the two bundled font packages under OFL-1.1).
- **Why:** it is policy over lockfiles and needs no build. It stops a licence we can't ship, a git source, a wildcard version, a new dependency with a high advisory, or a half-landed Tauri bump from reaching `main`.
- **When / where:** `supplyChain` lane (any manifest, lockfile or `deny.toml`), Linux.
- **Local:** `node tools/ci/cli.mjs tauri-alignment` (in `check.mjs`), and `cargo deny check bans licenses sources` after `cargo install --locked cargo-deny`. Dependency review runs only in CI.

### `automation`

- **What:** actionlint, zizmor, JSON-schema checks of the issue forms and `dependabot.yml`, and `node --test "tools/**/*.test.mjs"` (the tooling suite).
- **Why:** broken automation must fail a PR instead of silently stopping. A typo in `dependabot.yml` otherwise disables updates; an expression injection or over-broad permission otherwise ships.
- **When / where:** `automation` lane (`.github/`, `tools/`), Linux.
- **Local:** `node --test "tools/**/*.test.mjs"` (in `check.mjs`). actionlint, zizmor and check-jsonschema run only in CI; the versions are in [Pinned versions](#pinned-versions-dependabot-cant-bump).

### `pr-title`

- **What:** `checkPrTitle`. The title must be `<type>(<scope>): <description>`; the scope is optional and `!` before the colon marks a breaking change. Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `research`, `perf`, `build`, `ci`, `revert`.
- **Why:** PRs are squash-merged, so the title *is* the `main` commit and the release-notes line.
- **When / where:** pull requests only, Linux.
- **Local:** `PR_TITLE="fix(x): y" node tools/ci/cli.mjs pr-title`.

### `bundle (macos)`, `bundle (windows)`, `bundle (windows-arm64)`, `bundle (linux)` and `bundle (linux-arm64)`

- **What:** call the shared [`build.yml`](../.github/workflows/build.yml) with `release: false`: an unsigned release-profile `tauri build` (macOS `.app` + `.dmg`; Windows NSIS installer, x64 and arm64; Linux AppImage, `.deb` and `.rpm`, x64 and arm64). The artifact is kept 7 days.
- **Why:** a debug `cargo test` never runs `tauri build`. This catches config, capability, icon, resource and frontend-embedding breakage.
- **When / where:** `bundle` lane on PRs (Tauri config or capabilities, icons (release and dev), bundle resources, manifests and lockfiles, build scripts, the build workflow); **always** on `main` and `release/**`, so no commit is released without a proven bundle.
- **Local:** `node tools/check.mjs` builds your OS's bundle (native architecture). It reports the other OS's bundles as skipped.

### `gate`

- **What:** `needs` every job above and runs `evaluateGate` (`if: always()`).
- **Why:** it is the one required status check, so adding, renaming or removing a job never touches the ruleset.
- **Passes** when every job succeeded, or was skipped because its lane is off (or `pr-title` on a push). **Fails** when any job failed, was cancelled, or was skipped although its lane was on.
- **When / where:** every run, Linux. On a `main` push, a green `gate` is what makes the commit releasable.
- **Local:** `node tools/check.mjs`.

## Lanes

`lanesFor` turns lanes on from the paths a PR changes. Pushes, schedules and manual runs turn everything on, and so does any input it can't judge.

| Lane | Turns on when the PR changes… |
| --- | --- |
| `rust` | crates, Cargo manifests or lock, the toolchain file, Cargo config, the nextest config, the shared Rust setup action, the generated bindings |
| `web` | the web app, `.node-version` |
| `bundle` | Tauri config or capabilities, icons (release and dev), bundle resources, Cargo or web manifests and lockfiles, build scripts, the shared build workflow, `.node-version` |
| `supplyChain` | any manifest or lockfile, `web/pnpm-workspace.yaml`, `deny.toml` |
| `automation` | `.github/`, `tools/` |

Docs and the assets folder (icon masters and palette) match no lane, so a docs-only PR runs `changes`, `pr-title` and `gate` only. The exception is `docs/licenses/`, which is bundled as app resources and turns on `bundle`.

## Test layers

| Layer | What it proves | Where |
| --- | --- | --- |
| Rust unit tests | Local logic per crate | `rust (macos)`, `rust (windows)`, `rust (linux)` |
| `oxide-core` integration tests | Behaviour through the Core API (Projects, terminals, files, git, GitHub through a fake `gh`, the upgrade migration…) with temp repositories | both Rust jobs |
| Bindings and capabilities test | TypeScript bindings match the Tauri commands, and the webview has no filesystem, shell or process capability | both Rust jobs, plus the committed-bindings diff |
| Web component tests (Vitest, jsdom) | Frontend behaviour against mocked IPC | `web` |
| Tooling tests | Every pipeline decision | `automation` |
| App bundles | `tauri build` succeeds with the real config, icons, resources and embedded frontend | every `bundle (...)` job |
| Live language installs (`#[ignore]`) | The language-support downloads still work | A Release Manager's machine, before publishing. Never in CI: they need network |
| UI regression script (`web/scripts/terminal-regression.cjs`) | The terminal layout in a real window, with a screenshot written to `web/test-results/` (ignored by Git) | By hand during UI work. Not a gate |

nextest runs each test in its own process with the settings in [`.config/nextest.toml`](../.config/nextest.toml): a hard per-test timeout of 5 minutes, one retry (a pass on retry is reported as flaky, not hidden), JUnit output, and a `process-heavy` test group capped at 2 threads for the suites that spawn child processes and PTYs (the Provider adapters, the terminal tests, `thread_checkout_git` and the whole `workbench` binary, whose shell-completion test drives a shell under a 5 s budget), which time out under full parallelism.

## Release workflows

### `build.yml` (shared build)

- **What:** the one place installers are built. Inputs: `platform` (`macos-aarch64`, `windows-x64`, `windows-aarch64`, `linux-x64` or `linux-aarch64`) and `release`.
  - `release: false` (CI): unsigned, caches allowed.
  - `release: true`: no caches at all, frozen installs. Apple signing and notarization would switch on by themselves if the Apple secrets existed; they deliberately don't ([ADR-0013](adr/0013-ship-macos-builds-ad-hoc-signed.md)), so the macOS build is ad-hoc signed (Apple Silicon refuses to launch an app with no signature) and the notes say so.
- **Why:** PR bundles and release bundles come from one definition, so what `main` proves is what ships. It declares the `release` environment itself, because a job that calls a reusable workflow can't name one, and the approval must guard the job that reads the secrets.
- **Bundles:** macOS `app,dmg`; Windows `nsis` only; Linux `appimage,deb,rpm`. A release build also makes the updater packages and signs them with the update key ([ADR-0021](adr/0021-update-channels-per-platform.md)): it merges `crates/oxide-app/tauri.updater.conf.json` (`createUpdaterArtifacts`) over the app config, so CI builds, which have no key, stay unsigned. The updater packages are the macOS `.app` archive (`Oxide_<v>_macos_arm64.app.tar.gz`) and, for Windows and Linux, the installer and AppImage that are already downloads. Each has a `.sig` next to it. The first release step after the checkout and tool set-up runs `require-secrets`: a release without `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `OXIDE_REPOSITORY_SIGNING_KEY` or `OXIDE_REPOSITORY_SIGNING_KEY_PASSPHRASE` in the `release` environment fails there, naming the missing secret, before anything is built. The check passes each secret only as a presence flag (`HAS_<NAME>: ${{ secrets.<NAME> != '' }}`, `require-secrets --present`), so no key's value enters the build jobs' environment through it. Only the Tauri build steps read the update key; the build jobs never read the repository key.
- **Runners:** Windows on Arm builds natively on `windows-11-arm`, and Linux on `ubuntu-22.04` and `ubuntu-22.04-arm`: an AppImage or `.deb` links the glibc it was built against, so the oldest supported image keeps it running on older distributions. Move to `ubuntu-24.04*` only when 22.04 is retired.
- **Local:** `node tools/check.mjs` builds an unsigned bundle for your OS. Signed builds are never made locally.

### `release.yml` (Release)

Trigger: a `v*.*.*` tag. Concurrency is per tag and never cancelled.

1. **`verify`**, **`audit-rust`** and **`audit-js`** (parallel, read-only). `audit-rust` runs `cargo deny --locked check advisories` and `audit-js` runs `pnpm --dir web audit --prod --audit-level high`; `build` needs all three. *Why:* a daily scan only finds an advisory within a day, and nothing else stopped a tag from shipping one; failing here means no signing secret is unlocked and nothing is built. A high advisory with no fix blocks the release until it is resolved. `verify`: the tagged commit is an ancestor of `main` or a `release/*` branch; `checkReleaseVersion` finds the tag equal to the versions in `Cargo.toml`, `crates/oxide-app/tauri.conf.json` and `web/package.json`; `gate` succeeded on that commit's push run. *Why the last one:* the ruleset doesn't require up-to-date branches, so two individually green PRs can break together. Each refusal says what failed and how to fix it.
2. **`build`** (all five platforms in parallel, `release: true`) waits for approval of the `release` environment.
3. **`repositories`** (needs `build`; names the `release` environment, so it is approved like the builds; `contents: read`; the only job that reads the repository key). It checks the repository secrets first, downloads the Linux builds and runs [`tools/ci/sign-repositories.sh`](../tools/ci/sign-repositories.sh), which: signs every `.rpm` with the repository key (`rpmsign`); builds the APT flat repository (`dpkg-scanpackages` over the amd64 and arm64 `.deb` files, the pure `aptReleaseFile` for `Release`, then `InRelease` by clear-signing it); exports the public key as `oxide-repository.gpg` (binary, for `signed-by`) and `oxide-repository.asc`; builds the DNF metadata with `createrepo_c --baseurl <the release's assets>` and signs `repomd.xml` (`repomd.xml.asc`); then checks its own output with the public key only (`gpgv`, `gpg --verify`, `rpmkeys --checksig`). Which packages form a repository, and whether the DNF metadata is for the site (stable only), is the tested `repositoryPlan` in `tools/ci/policy.mjs`. It uploads the `repository-release` artifact (signed `.rpm` files, `InRelease`, `Release`, `Packages` and the key: these become release assets) and the `dnf-site` artifact (the `rpm/` folder of the update site, 90 days). Pre-releases go through it too, so an `-rc` draft's assets can rehearse both repositories, but their metadata is never written to the site. It needs a second approval of the `release` environment (GitHub asks per job); publishing the draft needs none, because everything is already signed.
4. **`publish`** (the only job with `contents`, `id-token` and `attestations: write`; it holds no signing secrets; it needs `build` and `repositories`): stages the installers, the updater packages and their `.sig` files, named `Oxide_<v>_<os>_<arch>.<ext>` so the platform is in the file name (`macos_arm64.dmg`, `windows_x64.exe`, `windows_arm64.exe`, and `linux_x64` / `linux_arm64` as `.AppImage`, `.deb` and `.rpm`; `build.yml` renames them from Tauri's names) for the release, writes `latest.json` from the signatures (the pure `buildUpdateFeed`, which fails on a missing or empty signature; its entries point at this release's own assets), attests build provenance for all of them, writes `SHA256SUMS.txt` and the SPDX SBOM to the `release-metadata` workflow artifact (so release assets stay clean), embeds the SHA-256 checksums of the installers in the notes (the updater-only assets, the `.app.tar.gz`, the `.sig` files and `latest.json`, are left out of the notes and the Downloads table), copies the `repository-release` files over the build's (so the signed `.rpm` replaces the unsigned one before anything is checksummed or attested; the APT index and the key are left out of the notes' checksum list), and creates a **draft** release (a pre-release when the tag has a suffix such as `-rc.1`).

**Why rebuild at release instead of promoting `main`'s CI bundle:** signing happens inside `tauri build`, so promoting would mean giving every `main` push any signing secrets without approval. A clean, cache-free rebuild of the same commit, with locked dependencies and a pinned toolchain, is the safer trade.

**Why no "prepare release" workflow that opens the bump PR:** a PR made with `GITHUB_TOKEN` triggers no workflows, so its `gate` would never run. Avoiding that needs an extra credential just to save one local command.

**Release notes** come from the Conventional Commit titles merged since the previous `v*` tag, grouped into Breaking changes, Features, Fixes, Dependencies, Documentation and Other, with PR links. `chore(release)` commits are omitted. They continue with a **Downloads** table that says which installer is for which platform (for example `_linux_x64.AppImage` is "Linux (Intel/AMD, 64-bit)"), and end with a per-platform signing notice.

**Local:** `node tools/ci/cli.mjs bump X.Y.Z` (see the runbook), `node tools/ci/cli.mjs release-version vX.Y.Z` (does the tag match the manifests?), `node tools/ci/cli.mjs release-notes vX.Y.Z` (needs full git history).

### `verify-release.yml` (Verify release)

- **What:** when a release is published, first checks that the release's pre-release flag agrees with its tag (flagged if and only if the tag has a `-` suffix; the pure `checkPrerelease`, `cli.mjs check-prerelease`) and fails before downloading or writing anything when it does not; releases v0.0.2 to v0.0.4 were flagged as pre-releases by hand without a suffix, which GitHub's `latest` link, the stable feed and the repositories all skip, so untick *Set as a pre-release* on a stable release before publishing it (a stable release can only be corrected by rolling forward). Then it re-downloads every installer and checks `SHA256SUMS.txt` from the `release-metadata` run artifact and runs `gh attestation verify` on each file.
- **Why:** it checks what users will actually download, and keeping the checksums and the SBOM off the release keeps the release page limited to the installers. A failure opens a `needs-triage` issue, so it is triaged even if nobody watches Actions.
- **Blocking:** it can't block a publish that already happened. The remedy is to roll forward.
- **Local:** `gh attestation verify <file> --repo getoxide/oxide` and compare SHA-256 against the release notes.

The same workflow has a second job, **`update feeds`** (it needs the first; it holds no signing key, only the `contents: write` token). It copies the published release's `latest.json` to `updates/prerelease.json` on the `updates` branch and pushes it (the first run creates the orphan branch), then fetches both feeds, retrying for up to 10 minutes while GitHub Pages catches up, and checks them with `checkPublishedFeeds`: the pre-release feed names the published version; the stable feed names it too for a stable release and must not for a pre-release; every entry has a signature and points at the release's own assets; every package URL resolves. A failure opens a `needs-triage` issue.

The same workflow has a third job, **`linux repositories`** (it needs `update feeds`; it holds no signing key, only the `contents: write` token; same `update-site` concurrency group). It decides with `repositoryPlan`: for a **stable** release it replaces the `rpm/` folder of the `updates` branch with the signed `dnf-site` artifact of the release run; for a pre-release it leaves the branch untouched. Then it checks both repositories the way a system fetches them: APT from `https://github.com/getoxide/oxide/releases/latest/download/` (a stable release; the tag's own assets for a pre-release): `gpgv` verifies `InRelease` against the published key, `Release` must match it and pin `Packages`, and `Packages` must name the amd64 and arm64 packages with the SHA-256 of the published files (`checkAptRepository`); DNF from `https://getoxide.github.io/oxide/rpm/` (stable only, retrying while Pages catches up): the key is the release's key, `repomd.xml.asc` verifies, `repomd.xml` pins `primary`, every package location is the release's own asset with the published hash (`checkDnfRepository`), and every `.rpm` passes `rpmkeys --checksig`. A failure opens a `needs-triage` issue. The checks prove the repository is consistent with itself and with the release; they cannot prove the key is the one users trust, so compare the fingerprint of `oxide-repository.asc` with the one you recorded when the key was made.

### The Linux repositories

| | Address | Where it lives |
| --- | --- | --- |
| APT (flat) | `deb [signed-by=/usr/share/keyrings/oxide.gpg] https://github.com/getoxide/oxide/releases/latest/download/ ./` | release assets: `InRelease`, `Release`, `Packages` (one index for amd64 and arm64), the `.deb` files, `oxide-repository.gpg` |
| DNF | `https://getoxide.github.io/oxide/rpm/` (`oxide.repo` is served next to the metadata) | `rpm/` on the `updates` branch: `repodata/`, `oxide-repository.asc`, `oxide.repo`; each package's location is the release's own `.rpm` asset |

The addresses are written into users' systems: changing them means every Linux install has to be set up again by hand. One OpenPGP key (RSA 4096: older RPM cannot verify EdDSA) signs the APT `InRelease`, every `.rpm` (so `gpgcheck` and `repo_gpgcheck` both pass) and `repomd.xml`. Make it once and keep the private half only in the `release` environment:

```sh
gpg --quick-generate-key "Oxide Repository <releases@getoxide.dev>" rsa4096 sign never   # choose a passphrase
gpg --armor --export-secret-keys <fingerprint>   # the value of OXIDE_REPOSITORY_SIGNING_KEY
```

Then export its public half into the repository, where the `.deb` picks it up: `tools/ci/export-repository-key.sh <armored public key>` writes `crates/oxide-app/linux/repository/oxide-repository.gpg`, and `sign-repositories.sh` refuses to sign a release whose key differs from that file. **The committed file must be the real key before the first release**; until then it is a rehearsal key.

Record the fingerprint where Release Managers can find it. Rotating the key means every user imports the new key by hand (the setup instructions in the README fetch it from the latest release, so an APT user who re-runs them gets it; DNF users re-run `dnf`'s key import).

**Package maintainer scripts** (they run as root on users' systems; ADR-0016). The `.deb` and `.rpm` downloaded from a release add the repository themselves, wired through `bundle.linux.{deb,rpm}` in `tauri.conf.json` and written in POSIX sh under `crates/oxide-app/linux/`:

- `.deb` `postinst` (on `configure`, so on install and upgrade): copies the shipped public key to `/usr/share/keyrings/oxide.gpg` and writes the one-line source to `/etc/apt/sources.list.d/oxide.list`, unless that file or any other APT source already names the repository. `postrm` runs only on `purge`: it deletes `oxide.list` while it is still exactly the line above and the keyring while no source uses it. `apt remove` keeps both.
- `.rpm` `%post` writes `/etc/yum.repos.d/oxide.repo` (the same content as the documented `oxide.repo`) unless it, or another repo file that names the repository, exists; `%preun` removes it on erase only (`$1` is 0, never on upgrade) while it is unchanged. rpm holds the keyring lock for the whole transaction, so a scriptlet can neither import nor delete a key: `dnf` imports the key from the repo file's `gpgkey` on first use (the prompt the documented setup has), and it stays in the rpm keyring after an erase (remove it by hand with `rpm -qa gpg-pubkey --qf '%{NAME}-%{VERSION}-%{RELEASE} %{SUMMARY}\n' | grep -i oxide`, then `sudo rpm -e <that name>`). The repo file sets `skip_if_unavailable=1` so an unreachable repository never breaks the user's `dnf`. Both scripts add nothing when the package's own version is a pre-release (`-` in the `.deb` version, `-`, `_` or `~` in the `.rpm` one), because pre-releases never enter the repositories.
- The scripts touch nothing else: `tools/ci/maintainer-scripts.test.mjs` pins the paths, the lines against `tools/ci/policy.mjs` (`aptSourceFile`, `dnfRepoFile`) and the README commands, and runs shellcheck. A file the user edited is never overwritten or deleted.

**Rehearsal before 1.0.0.** Publish two `-rc` drafts, download their assets into a directory laid out like the published repositories (APT files at the root, `rpm/` with the DNF metadata, each tag's assets under `download/<tag>/`), serve it over HTTP and point Debian, Ubuntu and Fedora containers (x64 and arm64, `--platform`) at it: follow the README steps with the local addresses, install from the first draft and upgrade to the second with signature checking on. `tools/ci/sign-repositories.sh` takes a fourth argument, the base URL of the packages, so the DNF metadata of a rehearsal can name the local server.

### The update feeds

Every install reads one feed ([ADR-0021](adr/0021-update-channels-per-platform.md)); the addresses are compiled into the app (`crates/oxide-core/src/updates.rs`) and cannot change without every install updating by hand once.

| Feed | Read by | Address | Served from |
| --- | --- | --- | --- |
| Stable | installs whose version has no pre-release suffix | `https://github.com/getoxide/oxide/releases/latest/download/latest.json` | the `latest.json` asset of the latest release; GitHub never resolves "latest" to a draft or a pre-release, so it goes live when a Release Manager publishes |
| Pre-release | installs whose version is `-rc.N` | `https://getoxide.github.io/oxide/updates/prerelease.json` | the `updates` branch, served by GitHub Pages; the newest published release of any kind, written by `verify-release.yml` |

The `updates` branch holds only generated files (`updates/prerelease.json` and `.nojekyll`) and no history anyone needs. Nothing but `verify-release.yml` writes it. Debug builds may point the app at another feed for local trials (see CONTRIBUTING); a release build ignores that ([ADR-0016](adr/0016-security-boundaries.md)).

The update key is a minisign key pair made with `tauri signer generate`. The public key is in `crates/oxide-app/tauri.conf.json` (`plugins.updater.pubkey`); the private key and its password are the `release` environment secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Losing the key means every install updates by hand once. Rotating it means shipping one release signed with the old key that carries the new public key.

## Scheduled and automatic workflows

### `advisories.yml` (Advisories)

- **What:** daily (and on manual dispatch) two jobs. `cargo-deny` runs `cargo deny check advisories` over the whole Rust tree (yanked crates are denied; unmaintained crates are reported for direct dependencies only). `pnpm-audit` runs `pnpm --dir web audit --prod --audit-level high` over the production JavaScript dependencies. On failure each opens, or comments on, its own `needs-triage` tracking issue ("Security advisories found in Rust dependencies" or "... in JavaScript dependencies").
- **Why not on PRs:** a new advisory against an untouched dependency would block unrelated work. *Why on top of Dependabot alerts:* RustSec also reports unmaintained and yanked crates, and a scheduled `pnpm audit` gives the JavaScript side the same tracking issue and the same release gate (see `release.yml`) instead of relying on alerts alone. The scans are listed in `ADVISORY_SCANS` in `policy.mjs`, and a test requires both workflows to run them.
- **Blocking:** not for PRs; it does block a release (`audit-rust` and `audit-js` in `release.yml`). **Local:** `cargo deny --locked check advisories`, `pnpm --dir web audit --prod --audit-level high`.

### `dependabot-auto-merge.yml` (Dependabot auto-merge)

- **What:** acts only on PRs *authored* by `dependabot[bot]` into `main` (the author, not the actor, so a human re-run still qualifies and a human PR never does). `dependabotDecision` picks: **auto** (patches, and minors of packages at 1.0 or later) enables squash auto-merge, and `gate` stays the only judge; **manual** (majors, 0.x minors, 0.0.x patches, the `tauri` and `specta` groups, anything unreadable) applies the `manual-review` label and a comment.
- **Why a GitHub App token:** a merge made with `GITHUB_TOKEN` triggers no `push` workflow, so the merge commit would never get a `gate` result and could never be released. The App credentials are the Dependabot secrets `AUTOMERGE_APP_ID` and `AUTOMERGE_APP_PRIVATE_KEY`. Without them the workflow only labels and comments.
- **Config:** [`.github/dependabot.yml`](../.github/dependabot.yml) covers Cargo, the pnpm web app, GitHub Actions and the Rust toolchain, weekly on Monday at 07:00 Europe/Rome, with cooldowns (Cargo: 3 days patch, 7 minor, 14 major; pnpm: 7, 7, 14, to match `minimumReleaseAge`; Actions and the toolchain: 7; security updates are not delayed) and groups for packages that break when moved alone. The `supply-chain` job rejects Tauri drift if only half of a bump lands. [CONTRIBUTING](../CONTRIBUTING.md#dependencies-and-supply-chain-policy) has the details.
- **pnpm:** `web/pnpm-workspace.yaml` sets `minimumReleaseAge` (7 days) and an explicit `allowBuilds` list, because Dependabot's cooldown only protects the updates Dependabot makes.

## Release runbook

Only a Release Manager does this. Hotfixes on `release/x.y` branches follow the same steps and the same gates.

1. **Bump.** `node tools/ci/cli.mjs bump X.Y.Z` writes the version into `Cargo.toml`, `crates/oxide-app/tauri.conf.json` and `web/package.json` and refreshes the workspace entries of `Cargo.lock`. Open a PR titled `chore(release): vX.Y.Z`, and merge it like any other. Use `X.Y.Z-rc.N` for a release candidate.
2. **Wait for `gate`** on the `main` run of the merge commit. That run also builds every bundle.
3. **Tag** the merged commit, annotated, and push it:

   ```sh
   git tag -a vX.Y.Z <sha> -m "Oxide vX.Y.Z"
   git push origin vX.Y.Z
   ```

   If `verify` refuses, its message says what to fix. A pushed tag can't be moved or deleted (only the admin can); fix forward with the next version, or have the admin delete a mistaken tag.
4. **Approve** the `release` deployment: Actions → Release → *Review deployments*. Either Release Manager may approve. GitHub asks again for the `repositories` job once the builds finish (it reads the repository key); approve it too.
5. **Smoke test.** When `publish` finishes there is a **draft** release. Download its builds, open a Project, open a terminal and check Files (from the Project row), Issues and Pull request (right dock) on each platform you can. Run the live language-install tests where the network allows:

   ```sh
   cargo test -p oxide-core --test language_install_live -- --ignored
   ```

6. **Publish.** Edit the notes, then click Publish. The release becomes immutable.
7. **Watch** the *Verify release* run. If it opens an issue, roll forward. Its first step refuses a release whose *pre-release* box disagrees with the tag (a `-rc` tag must be ticked, a stable tag must not): GitHub's "latest" link, the stable feed and the repositories skip a flagged release. Nothing is written in that case; a published release is immutable, so fix it forward.
   The `update feeds` and `linux repositories` jobs are gated by `needs:`: when `verify` (or `update feeds`) fails, the later jobs are skipped and never run on their own. After fixing the cause, re-run them by hand: open the failed run → *Re-run failed jobs* (this re-runs the failed job and the skipped jobs that need it), or from the CLI `gh run rerun <run-id> --failed --repo getoxide/oxide`. A run older than 90 days has lost its `dnf-site` artifact, so rebuild by rolling forward instead.

**First release with the updater.** Pages can't be enabled from a branch that doesn't exist, and the first published release creates it, so before tagging create the branch and enable Pages once:

```sh
git switch --orphan updates && touch .nojekyll && git add .nojekyll && git commit -m "Create the update site"
git push origin updates
gh api -X POST repos/getoxide/oxide/pages -f "source[branch]=updates" -f "source[path]=/"
gh api repos/getoxide/oxide/pages   # source.branch must be updates, status built or building
```

**Rehearsal.** Tag `vX.Y.Z-rc.1` after the bump merged. It produces a draft pre-release (`releases/latest` skips drafts and pre-releases). Afterwards the admin deletes the draft and the tag (deleting a tag needs the bypass).

**Rollback is rolling forward.** Published releases are immutable and users only move forward. Never try to edit one under pressure: publish `vX.Y.Z+1`. While Oxide is pre-1.0, a minor bump may break and a patch bump only fixes.

## Secrets and the fork/PR threat model

- **Signing secrets exist only in the `release` environment:** `TAURI_SIGNING_PRIVATE_KEY` (the content of the minisign update key, not a path), `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `OXIDE_REPOSITORY_SIGNING_KEY` (the armored private OpenPGP key of the APT and DNF repositories) and `OXIDE_REPOSITORY_SIGNING_KEY_PASSPHRASE`. A release fails at its first build step when any is missing. Only the Tauri build steps read the update key, and only the `repositories` job reads the repository key. They are readable only by a job for a `v*` tag after a Release Manager approves.
- **The Apple secrets are intentionally absent.** Oxide does not join the Apple Developer Program ([ADR-0013](adr/0013-ship-macos-builds-ad-hoc-signed.md)), so `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_API_ISSUER`, `APPLE_API_KEY` and `APPLE_API_PRIVATE_KEY` must not be set. If they ever exist, the Apple step in `build.yml` signs and notarizes with no other change; rehearse on an `-rc` tag before relying on it.
- **Fork PRs** run on `pull_request` with a read-only token and no secrets. Actions settings require approval for first-time contributors.
- **No `pull_request_target` workflow checks out PR code.** Untrusted code never gets a write token.
- **Every workflow starts from `contents: read`** (auto-merge from none) and grants more per job: `publish` alone writes releases and attestations, `verify-release` writes failure issues and the `updates` branch (feeds and the DNF metadata), `advisories` alone writes issues, and the auto-merge job alone writes pull requests. Auto-merge also mints a short-lived GitHub App token, scoped to contents, pull requests and workflows, only for low-risk Dependabot PRs.
- **Checkouts don't persist credentials,** so later steps can't push with the token.
- **Third-party actions are pinned to a full commit SHA** with a version comment, so a moved tag can't inject code. Dependabot keeps the pins current.
- **Release builds are clean:** no cache is restored or saved, so a poisoned cache can't reach a shipped binary.
- **actionlint and zizmor** run on every PR that touches `.github/`.
- **Dependency intake:** cooldowns on Dependabot, `minimumReleaseAge` and an install-script allowlist in pnpm, `cargo-deny` licences and sources, dependency review on PRs.
- **Users can verify a download** with the SHA-256 checksums in the release notes or `gh attestation verify`, which ties it to the exact workflow run and commit.
- **CodeQL** (default setup for Actions, JavaScript/TypeScript and Rust) is advisory, not merge-blocking: Rust analysis is young and its false-positive rate here is unknown. Promote it to a code-scanning ruleset rule once the baseline is clean.

## Pinned versions Dependabot can't bump

| What | Pinned in | Bumped by |
| --- | --- | --- |
| Rust toolchain, rustfmt, clippy | `rust-toolchain.toml` | Dependabot |
| Actions | full SHA + version comment | Dependabot |
| Node (22) | `.node-version` | by hand |
| pnpm | `packageManager` in `web/package.json` | by hand |
| cargo-nextest | `ci.yml` (`taiki-e/install-action` input) | by hand |
| cargo-deny | `ci.yml` (`supply-chain`) and `advisories.yml` | by hand |
| zizmor | `ci.yml` (`taiki-e/install-action` input) | by hand |
| actionlint (version and SHA-256) | `ci.yml`, `automation` job | by hand |
| check-jsonschema | `ci.yml`, `automation` job | by hand |
| Runner images (`ubuntu-24.04`, `ubuntu-22.04`, `ubuntu-22.04-arm`, `macos-15`, `windows-2025`, `windows-11-arm`) | workflow `runs-on` | by hand, when GitHub announces a deprecation |
| CUDA Toolkit (12.9.1) and Vulkan SDK (1.4.363.0), with SHA-256 | `GPU_BUILD_SDKS` in `tools/ci/policy.mjs` | by hand. CUDA stays on 12.x (13 drops compute capability below 7.5); a new CUDA major also renames the runtime DLLs, which the tests check |

When bumping a tool by hand, change it everywhere it appears (`grep` for the version) and keep the local install instructions in CONTRIBUTING in step.

## What to do with a flaky test

A test that fails and then passes on retry is **flaky**: nextest retries once and lists it under "Flaky tests" in the job summary, so it is visible and countable. A retry is not a fix.

1. **Open an issue** naming the test, the OS and the failing output. Link the CI run.
2. **Find the cause.** Usually shared state, a fixed port or path, a wall-clock timing assumption, or contention. For process-heavy suites, check whether they belong in the `process-heavy` group in `.config/nextest.toml`.
3. **Fix it** in the same PR if the cause is clear.
4. **Otherwise quarantine it explicitly:** mark it `#[ignore = "flaky: #<issue>"]` so the reason and the issue are in the code. Don't raise `retries`, lengthen a timeout to hide it, or merge past a red `gate`.
5. A test that fails twice is a real failure, not a flaky one.

## GitHub settings

These live in the GitHub UI, not in the repository, so they are recorded here. An admin sets them.

- **Repository:** squash merge only (merge commits and rebase off); auto-merge and delete-branch-on-merge on; **immutable releases** on. Actions: default workflow token read-only, "Allow Actions to create and approve PRs" off, approval required for fork PRs from first-time contributors.
- **Ruleset `main protection`** (and the same for `release/**`): PR required with 0 approvals; required status check `gate` (up-to-date branch not required); squash only; no force-push; no deletion.
- **Ruleset `release tags`** on `refs/tags/v*`: block update and deletion; bypass for the repository admin only.
- **Environment `release`:** required reviewers `cavallinilorenzo` and `itsmrma`; deployment refs `v*` tags only; the secrets above.
- **GitHub Pages:** enabled, source *Deploy from a branch*, branch `updates`, folder `/ (root)`. It serves the pre-release feed at `https://getoxide.github.io/oxide/`. Create the branch first (see the runbook, *First release with the updater*): Pages can't be enabled from a branch that doesn't exist. The `main protection` rulesets must not cover `updates`, because the workflow pushes to it.
- **Labels:** `dependencies`, `manual-review`, plus the triage labels.
- **Dependabot secrets** `AUTOMERGE_APP_ID` and `AUTOMERGE_APP_PRIVATE_KEY` (optional, for auto-merge).
- **Security:** secret scanning, push protection, Dependabot alerts and security updates, private vulnerability reporting, and CodeQL default setup.
