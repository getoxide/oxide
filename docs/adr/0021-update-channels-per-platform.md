# Update channels per platform

Oxide keeps itself up to date again. How it updates depends on how it was installed, and every channel takes the same GitHub release at the moment a Release Manager publishes it.

## Decision

- **In-app updates on macOS, Windows and the Linux AppImage.** Oxide checks a feed at launch and every 4 hours, shows an Update button when it is behind, and on one click downloads, verifies, installs and restarts. It uses the Tauri updater plugin with its standard packages: the `.app` archive on macOS, the NSIS installer in passive mode on Windows, the AppImage on Linux.
- **Feeds.** Stable installs read `latest.json` from the latest GitHub release (`releases/latest/download/latest.json`), which GitHub never resolves to a draft or a pre-release. Installs whose version is a pre-release read `prerelease.json` from the update site, `https://getoxide.github.io/oxide/` (GitHub Pages from the `updates` branch), so `-rc` tags can rehearse updates. There is no opt-in beta channel.
- **Signatures, not Apple.** Every updater package is signed with Oxide's minisign update key and refused if the signature does not match the public key compiled into the app. macOS stays ad-hoc signed (ADR-0013): the update does not need Apple signing.
- **APT and DNF for `.deb` and `.rpm`.** Package installs never update themselves. Oxide publishes a signed APT flat repository as assets of the latest release and a signed DNF repository whose metadata lives on the update site and whose packages are the release assets. The packages add the repository on install and remove it on purge. In these installs Oxide only tells the user a new version exists and shows the command to run.
- **One OpenPGP key for both repositories** (RSA 4096, because older RPM cannot verify EdDSA): it signs the APT `InRelease`, every `.rpm` and the DNF `repomd.xml`. Keys live only in the `release` environment, and repository metadata is signed during the approved release run, so publishing needs no second approval.
- **Pre-releases never reach the APT or DNF repositories**; repository changes are rehearsed by serving a draft's assets locally.

## Consequences

- The feed addresses and the repository addresses are compiled into every install or written into every system: changing them later means every install updates by hand once. Losing the update key has the same cost.
- The `.rpm` cannot import the repository key: rpm holds its keyring lock for the whole transaction, so a package script can neither import a key nor remove one. `dnf` imports the key from the `.repo` file's `gpgkey` on first use, and it stays in the rpm keyring after the package is erased; a user removes it by hand with `rpm -e gpg-pubkey-<version>-<release>`. The `.repo` file sets `skip_if_unavailable=1`, so an unreachable Oxide repository never breaks the user's `dnf`.
- A pre-release package adds no repository (the repositories only ever serve stable releases, so the source would answer 404).
- An ad-hoc signature changes with every build, so macOS may ask again for privacy permissions after an update; the `-rc` rehearsal measures it.
- Revisit when Oxide leaves GitHub, joins the Apple Developer Program, or adds another package channel.
