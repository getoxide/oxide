#!/bin/sh
# Removes Oxide's DNF repository and key when the package is erased. An upgrade runs this for the old
# version too ($1 is 1), and must keep both. Runs as root and deletes only /etc/yum.repos.d/oxide.repo
# (when it is still the file the package or the documented setup wrote) and Oxide's own imported key.

[ "$1" = 0 ] || exit 0

SHARE=/usr/share/oxide/repository
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

keyid=$(cat "$SHARE/oxide-repository.keyid" 2> /dev/null)
case "$keyid" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
    for key in $(rpm -q "gpg-pubkey-$keyid" 2> /dev/null); do
      rpm -e "$key" > /dev/null 2>&1 || :
    done
    ;;
esac
exit 0
