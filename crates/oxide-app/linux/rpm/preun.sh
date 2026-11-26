#!/bin/sh
# Removes Oxide's DNF repository and key when the package is erased. An upgrade runs this for the old
# version too ($1 is 1), and must keep both. Runs as root and deletes only /etc/yum.repos.d/oxide.repo
# (when it is still the file the package or the documented setup wrote). The key that dnf imported on first use stays in the rpm keyring: rpm holds the
# keyring lock for the whole transaction, so a scriptlet cannot remove it.

[ "$1" = 0 ] || exit 0

REPO=/etc/yum.repos.d/oxide.repo

if [ -f "$REPO" ] && [ ! -L "$REPO" ] && cmp -s "$REPO" - << 'EOF'
[oxide]
name=Oxide
baseurl=https://getoxide.github.io/oxide/rpm/
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=https://getoxide.github.io/oxide/rpm/oxide-repository.asc
metadata_expire=6h
EOF
then
  rm -f "$REPO"
fi

exit 0
