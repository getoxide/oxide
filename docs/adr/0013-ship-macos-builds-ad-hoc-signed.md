# Ship macOS builds ad-hoc signed, without Apple notarization

Oxide does not join the Apple Developer Program. Its macOS releases stay ad-hoc signed: no Developer ID certificate, no notarization, and no `APPLE_*` secrets in the `release` environment.

## Background and problem

`tauri build` signs and notarizes by itself when the Apple secrets exist, and falls back to an ad-hoc signature when they don't (see [docs/devops.md](../devops.md#release-workflows)). An ad-hoc signed app launches only after Gatekeeper's first-launch confirmation, and the release notes and README carry the steps for that.

[Issue #417](https://github.com/getoxide/oxide/issues/417) asked whether to join the Apple Developer Program (99 USD/year) and notarize **before or after** the first stable release. The trigger was the website's [Off-site distribution plan](https://github.com/getoxide/website/issues/17): the official Homebrew cask and Product Hunt wait for notarization, the cask is additionally gated on stars and repository age, and every launch text must carry the unsigned-build steps until then.

## Decision

- **Do not enroll, and do not notarize.** No Apple Developer Program membership, no Developer ID certificate and no `APPLE_*` secrets: macOS bundles ship as they do today, ad-hoc signed.
- **Keep the pipeline capable of it.** The Apple step in [`build.yml`](../../.github/workflows/build.yml) stays in place and dormant. Reversing this decision is adding the secrets and rehearsing with an `-rc` tag, not writing code.
- **Say it plainly.** README, release notes and the website's download copy describe the Gatekeeper steps as the normal experience, without promising notarization "soon".
- **Accept that two channels stay closed.** The official Homebrew cask and Product Hunt are not pursued while macOS is not notarized. The rest of the launch plan (an own tap whose cask carries the unsigned steps in `caveats`, winget, Show HN, Reddit, YouTube, awesome lists) does not depend on this.

The enrollment identity — individual versus organization, which decides whose name the certificate shows — is not decided either; it is settled only if the decision is reopened.

## Why

- **The fee buys polish, not capability.** Notarization removes the first-launch dialog, but the two channels it unlocks are themselves gated on 225 stars, 30 days of repository age and 14 days after launch. Launch-day channels work with the documented steps.
- **A recurring cost and a secret for a two-person, MIT, pre-release project.** An annual fee, an Apple account with two-factor authentication, a certificate to renew and rotate, and a key store to protect — with no revenue and no release published yet.
- **The trust path is already elsewhere.** Users verify a download with `SHA256SUMS.txt` and the build-provenance attestation, and installed apps accept only packages signed by the updater key. Notarization would not replace any of that.
- **The fallback is tested and documented.** Ad-hoc signing, the release-note notice and the README steps exist today; this decision keeps the documentation and the released artifacts consistent instead of promising a future state.

## Consequences

- Every macOS user meets Gatekeeper once. The README's [Opening an unsigned build](../../README.md#opening-an-unsigned-build) section and the website's `#macos-cant-be-opened` FAQ are the support path, and they stay accurate.
- The official Homebrew cask and Product Hunt remain unavailable for as long as this holds; the website plan's notarization gate never opens, and its "not notarized yet" copy needs a follow-up there.
- The Apple signing step in `build.yml` runs no notarization on any release, so that path is exercised only when the decision is reversed.
- Revisit when at least one of these is true: download volume makes first-launch friction a measurable loss; the official cask or Product Hunt becomes a priority worth 99 USD/year; an organization with a legal entity and a budget takes over publishing; or Apple makes notarization a prerequisite for the updater or for distribution.
