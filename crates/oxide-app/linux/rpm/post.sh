#!/bin/sh
# Adds Oxide's DNF repository and key, so a later `dnf upgrade` keeps Oxide current (ADR-0021).
# Runs as root. It writes only /etc/yum.repos.d/oxide.repo, the file the documented setup writes, and
# never fails the install over it. The key is not imported here: rpm holds the keyring lock for the
# whole transaction, so `rpm --import` cannot run in a scriptlet. dnf imports it from the repository
# file's gpgkey on first use, the same prompt the documented setup has.
umask 022

REPO=/etc/yum.repos.d/oxide.repo

write_repo() {
  tmp="$REPO.new.$$"
  cat > "$tmp" << 'EOF'
[oxide]
name=Oxide
baseurl=https://getoxide.github.io/oxide/rpm/
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=https://getoxide.github.io/oxide/rpm/oxide-repository.asc
metadata_expire=6h
EOF
  mv -f "$tmp" "$REPO"
}

# Written once: a file that is already there (the documented setup, or the user's own edit) stays,
# and so does any other repo file that already names the repository.
if [ ! -e "$REPO" ] && [ ! -L "$REPO" ] && ! grep -qsF 'getoxide.github.io/oxide/rpm' /etc/yum.repos.d/*.repo; then
  write_repo || { rm -f "$REPO.new.$$"; echo "oxide: could not add the DNF repository $REPO." >&2; }
fi

exit 0
