#!/usr/bin/env bash
# Signs the Linux packages and builds both repositories (ADR-0021). Runs in the approved release
# run, before the draft exists, so the checksums and attestations cover the signed packages.
#
#   OXIDE_REPOSITORY_SIGNING_KEY=<armored private key> OXIDE_REPOSITORY_SIGNING_KEY_PASSPHRASE=<passphrase> \
#     tools/ci/sign-repositories.sh <tag> <packages-dir> <out-dir> [<rpm-base-url>]
#
# <packages-dir> holds the built Oxide-<arch>.{deb,rpm} (x64 and arm64). <out-dir> gets:
#   assets/  the signed .rpm files and the APT flat repository (Packages, Release, InRelease, the public key)
#   dnf/     the DNF site folder: repodata/ (with a signed repomd.xml), the armored key and oxide.repo
# <rpm-base-url> is only for rehearsals against a local server; a release uses the release's own assets.
# Needs gpg, rpm (rpmsign, rpmkeys), dpkg-dev, createrepo-c (createrepo_c) and node.
set -euo pipefail

tag=${1:?usage: sign-repositories.sh <tag> <packages-dir> <out-dir> [<rpm-base-url>]}
packages=${2:?missing <packages-dir>}
out=${3:?missing <out-dir>}
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cli="$root/tools/ci/cli.mjs"
: "${OXIDE_REPOSITORY_SIGNING_KEY:?the repository signing key is not set}"
: "${OXIDE_REPOSITORY_SIGNING_KEY_PASSPHRASE:?the repository signing key passphrase is not set}"

# Which packages form the repositories, and whether the DNF metadata is for the update site.
plan=$(node "$cli" repository-plan "$tag" "$packages")
rpm_base=${4:-$(printf '%s' "$plan" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).dnf.baseUrl')}
debs=$(printf '%s' "$plan" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).debs.map((p) => p.name).join(" ")')
rpms=$(printf '%s' "$plan" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).rpms.map((p) => p.name).join(" ")')

umask 077
work=$(mktemp -d)
export GNUPGHOME="$work/gnupg"
mkdir "$GNUPGHOME"
# The agent gpg starts lives in $GNUPGHOME: stop it before the folder goes.
trap 'gpgconf --kill gpg-agent 2> /dev/null || true; rm -rf "$work"' EXIT
printf '%s' "$OXIDE_REPOSITORY_SIGNING_KEY" | gpg --batch --quiet --import
fingerprint=$(gpg --batch --with-colons --list-secret-keys | awk -F: '/^fpr:/ { print $10; exit }')
[ -n "$fingerprint" ] || { echo "The repository signing key has no secret key." >&2; exit 1; }
printf '%s' "$OXIDE_REPOSITORY_SIGNING_KEY_PASSPHRASE" > "$work/passphrase"
gpg_sign=(gpg --batch --yes --pinentry-mode loopback --passphrase-file "$work/passphrase" --local-user "$fingerprint")

mkdir -p "$out/assets" "$out/dnf/rpm"

# The public key: binary for apt's signed-by, armored for rpm and dnf.
gpg --batch --export "$fingerprint" > "$out/assets/oxide-repository.gpg"
gpg --batch --armor --export "$fingerprint" > "$out/assets/oxide-repository.asc"

# The .deb ships the public key (crates/oxide-app/linux/repository/) and write it on install: a
# release signed with any other key would leave every installed package trusting the wrong one.
shipped="$root/crates/oxide-app/linux/repository"
cmp -s "$out/assets/oxide-repository.gpg" "$shipped/oxide-repository.gpg" || {
  echo "The repository signing key is not the one the .deb ships ($shipped/oxide-repository.gpg). Run tools/ci/export-repository-key.sh with the new public key, rebuild and try again." >&2
  exit 1
}

# Every .rpm carries the signature, so gpgcheck passes.
for name in $rpms; do
  cp "$packages/$name" "$out/assets/$name"
  # Debian's rpm defines no gpg macros, so the whole signing command is spelled out.
  rpmsign --addsign \
    --define "__gpg $(command -v gpg)" \
    --define "_gpg_name $fingerprint" \
    --define "__gpg_sign_cmd %{__gpg} gpg --batch --no-verbose --no-armor --pinentry-mode loopback --passphrase-file $work/passphrase --no-secmem-warning -u \"%{_gpg_name}\" -sbo %{__signature_filename} --digest-algo sha256 %{__plaintext_filename}" \
    "$out/assets/$name" > /dev/null
done

# APT flat repository: one index for both architectures, signed as InRelease.
mkdir "$work/debs"
for name in $debs; do cp "$packages/$name" "$work/debs/$name"; done
(cd "$work/debs" && dpkg-scanpackages --multiversion . /dev/null > "$out/assets/Packages" 2> "$work/scan.log") || { cat "$work/scan.log" >&2; exit 1; }
node "$cli" apt-release "$out/assets/Packages" > "$out/assets/Release"
"${gpg_sign[@]}" --digest-algo SHA256 --clearsign --output "$out/assets/InRelease" "$out/assets/Release"

# DNF: metadata only; each package location points at the release's own assets.
mkdir "$work/rpms"
for name in $rpms; do cp "$out/assets/$name" "$work/rpms/$name"; done
createrepo_c --quiet --no-database --general-compress-type gz --baseurl "$rpm_base" "$work/rpms"
cp -r "$work/rpms/repodata" "$out/dnf/rpm/repodata"
"${gpg_sign[@]}" --digest-algo SHA256 --detach-sign --armor --output "$out/dnf/rpm/repodata/repomd.xml.asc" "$out/dnf/rpm/repodata/repomd.xml"
cp "$out/assets/oxide-repository.asc" "$out/dnf/rpm/oxide-repository.asc"
node "$cli" dnf-repo-file > "$out/dnf/rpm/oxide.repo"

# Check what was just signed, with the public key only, the way a user's system will.
mkdir "$work/verify"
gpgv --keyring "$out/assets/oxide-repository.gpg" --output "$work/verify/Release" "$out/assets/InRelease" 2> /dev/null
cmp "$work/verify/Release" "$out/assets/Release"
gpg --batch --verify "$out/dnf/rpm/repodata/repomd.xml.asc" "$out/dnf/rpm/repodata/repomd.xml" 2> /dev/null
rpmkeys --dbpath "$work/rpmdb" --import "$out/assets/oxide-repository.asc"
for name in $rpms; do
  rpmkeys --dbpath "$work/rpmdb" --checksig "$out/assets/$name" | grep -q "signatures OK" || { echo "$name is not signed." >&2; exit 1; }
done
echo "Signed $(wc -w <<< "$rpms" | tr -d ' ') rpm and $(wc -w <<< "$debs" | tr -d ' ') deb packages for $tag with key $fingerprint."
