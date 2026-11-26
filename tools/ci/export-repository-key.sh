#!/usr/bin/env bash
# Writes the three public-key files that the .deb and .rpm ship (crates/oxide-app/linux/repository/) from
# the armored PUBLIC key of the repository signing key. Run it once when the key is made or replaced:
#
#   tools/ci/export-repository-key.sh <oxide-repository.asc>
#
# sign-repositories.sh refuses to sign a release whose key differs from these files.
# Needs gpg. Never pass a private key.
set -euo pipefail

source=${1:?usage: export-repository-key.sh <armored public key>}
dest="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/crates/oxide-app/linux/repository"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
export GNUPGHOME="$work"
chmod 700 "$work"

gpg --batch --quiet --import "$source"
if gpg --batch --list-secret-keys --with-colons | grep -q '^sec'; then
  echo "$source holds a private key; pass the public key only." >&2
  exit 1
fi
fingerprint=$(gpg --batch --with-colons --list-keys | awk -F: '/^fpr:/ { print $10; exit }')
[ -n "$fingerprint" ] || { echo "No public key in $source." >&2; exit 1; }
mkdir -p "$dest"
gpg --batch --armor --export "$fingerprint" > "$dest/oxide-repository.asc"
gpg --batch --export "$fingerprint" > "$dest/oxide-repository.gpg"
# rpm names an imported key gpg-pubkey-<last 8 hex digits of the fingerprint, lower case>-<creation time>.
printf '%s\n' "$(printf '%s' "$fingerprint" | tail -c 8 | tr 'A-F' 'a-f')" > "$dest/oxide-repository.keyid"
echo "Wrote the key files for $fingerprint to $dest"
