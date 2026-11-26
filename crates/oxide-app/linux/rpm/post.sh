#!/bin/sh
# Adds Oxide's DNF repository and key, so a later `dnf upgrade` keeps Oxide current (ADR-0021).
# Runs as root. It writes only /etc/yum.repos.d/oxide.repo, the file the documented setup writes, and
# never fails the install over it. The key is not imported here: rpm holds the keyring lock for the
# whole transaction, so `rpm --import` cannot run in a scriptlet. dnf imports it from the repository
# file's gpgkey on first use, the same prompt the documented setup has.
umask 022

# A pre-release never enters the repositories (only stable releases do), so a repository added for it
# would answer 404. rpm writes its version with "_" or "~" where semver has "-" (0.1.0_rc.1).
# The scriptlet gets no version in its environment, so ask the rpm database: the transaction has already
# added this package, and during an upgrade the newest version is the one being installed.
version=$(rpm -q --qf '%{VERSION}\n' oxide 2>/dev/null | sort -V | tail -n 1)
case $version in
  *-*|*_*|*~*) exit 0 ;;
esac

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
skip_if_unavailable=1
EOF
  mv -f "$tmp" "$REPO"
}

# Written once: a file that is already there (the documented setup, or the user's own edit) stays,
# and so does any other repo file that already names the repository.
if [ ! -e "$REPO" ] && [ ! -L "$REPO" ] && ! grep -qsF 'getoxide.github.io/oxide/rpm' /etc/yum.repos.d/*.repo; then
  write_repo || { rm -f "$REPO.new.$$"; echo "oxide: could not add the DNF repository $REPO." >&2; }
fi

exit 0
