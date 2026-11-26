// The package maintainer scripts run as root on users' systems (ADR-0016), so what they may write
// and remove is pinned here: Oxide's own source and key files, and nothing else.
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { APT_KEYRING_PATH, APT_SOURCE_PATH, DNF_REPO_PATH, aptSourceFile, dnfRepoFile } from "./policy.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const app = join(root, "crates/oxide-app");
const read = (path) => readFileSync(join(root, path), "utf8");
const conf = JSON.parse(read("crates/oxide-app/tauri.conf.json"));
const SHARE = "/usr/share/oxide/repository";
const SCRIPTS = {
  debPostInstall: "crates/oxide-app/linux/deb/postinst",
  debPostRemove: "crates/oxide-app/linux/deb/postrm",
  rpmPostInstall: "crates/oxide-app/linux/rpm/post.sh",
  rpmPreRemove: "crates/oxide-app/linux/rpm/preun.sh",
};
const KEY_FILES = ["oxide-repository.gpg", "oxide-repository.asc", "oxide-repository.keyid"];

describe("Linux package maintainer scripts", () => {
  test("tauri.conf.json wires each script and ships the key files", () => {
    const { deb, rpm } = conf.bundle.linux;
    assert.equal(deb.postInstallScript, "linux/deb/postinst");
    assert.equal(deb.postRemoveScript, "linux/deb/postrm");
    assert.equal(rpm.postInstallScript, "linux/rpm/post.sh");
    assert.equal(rpm.preRemoveScript, "linux/rpm/preun.sh");
    for (const files of [deb.files, rpm.files]) {
      assert.deepEqual(files, Object.fromEntries(KEY_FILES.map((name) => [`${SHARE}/${name}`, `linux/repository/${name}`])));
    }
    for (const path of [...Object.values(deb.files), deb.postInstallScript, deb.postRemoveScript, rpm.postInstallScript, rpm.preRemoveScript]) {
      assert.ok(existsSync(join(app, path)), path);
    }
  });

  test("every script is POSIX sh, executable and passes shellcheck", () => {
    for (const path of Object.values(SCRIPTS)) {
      assert.match(read(path), /^#!\/bin\/sh\n/, path);
      assert.ok(statSync(join(root, path)).mode & 0o100, `${path} is not executable`);
      const shellcheck = spawnSync("shellcheck", ["--shell=sh", "--severity=style", join(root, path)], { encoding: "utf8" });
      if (shellcheck.error?.code === "ENOENT") return;
      assert.equal(shellcheck.status, 0, shellcheck.stdout);
    }
  });

  test("the scripts spell exactly the source line, repo file and paths of the policy", () => {
    const postinst = read(SCRIPTS.debPostInstall);
    assert.ok(postinst.includes(aptSourceFile().trimEnd()), "the .deb postinst writes the policy's source line");
    assert.ok(read(SCRIPTS.debPostRemove).includes(aptSourceFile().trimEnd()), "the .deb postrm compares with the policy's source line");
    for (const line of dnfRepoFile().split("\n").filter(Boolean)) {
      assert.ok(read(SCRIPTS.rpmPostInstall).includes(line), `the .rpm post lacks ${line}`);
      assert.ok(read(SCRIPTS.rpmPreRemove).includes(line), `the .rpm preun lacks ${line}`);
    }
  });

  test("the scripts touch no absolute path but Oxide's own files and the system tools", () => {
    const allowed = new Set([
      APT_SOURCE_PATH, APT_KEYRING_PATH, DNF_REPO_PATH, "/etc/apt/sources.list", "/etc/apt/sources.list.d", "/etc/yum.repos.d", "/usr/share/keyrings",
      SHARE, ...KEY_FILES.map((name) => `${SHARE}/${name}`), "/bin/sh", "/dev/null",
    ]);
    for (const path of Object.values(SCRIPTS)) {
      const text = read(path).split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
      for (const [, found] of text.matchAll(/(?<![\w$}.:-])(\/(?:etc|usr|var|bin|dev|opt|home|root|tmp)[\w./-]*)/g)) {
        assert.ok(allowed.has(found.replace(/\/$/, "")) || found.startsWith("/usr/share/oxide/repository/"), `${path} touches ${found}`);
      }
    }
  });

  test("the documented APT setup writes the same source and key paths", () => {
    const readme = read("README.md");
    assert.ok(readme.includes(`sudo tee ${APT_SOURCE_PATH}`));
    assert.ok(readme.includes(aptSourceFile().trimEnd()));
    assert.ok(readme.includes(`sudo tee ${APT_KEYRING_PATH}`));
    assert.ok(readme.includes(`-o ${DNF_REPO_PATH}`));
  });
});
