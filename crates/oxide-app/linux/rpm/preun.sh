#!/bin/sh
# Removes Oxide's DNF repository when the package is erased. An upgrade runs this for the old version
# too ($1 is 1), and must keep it. Runs as root and deletes only /etc/yum.repos.d/oxide.repo, and only
# while it is still the file the package or the documented setup wrote. The key that dnf imported on
# first use stays in the rpm keyring: rpm holds the keyring lock for the whole transaction, so a
# scriptlet cannot remove it.

[ "$1" = 0 ] || exit 0

REPO=/etc/yum.repos.d/oxide.repo

# Not `cmp`: a minimal Fedora image has no diffutils.
expected=$(cat << 'EOF'
[oxide]
name=Oxide
baseurl=https://updates.getoxide.dev/rpm/
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=https://updates.getoxide.dev/rpm/oxide-repository.asc
metadata_expire=6h
skip_if_unavailable=1
EOF
)
if [ -f "$REPO" ] && [ ! -L "$REPO" ] && [ "$(cat "$REPO")" = "$expected" ]; then
  rm -f "$REPO"
fi

exit 0
