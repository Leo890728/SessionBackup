import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BackupRepository,
  normalizeRemoteInput,
  parseGithubRepo,
  selectAutomaticBackupRepo,
} from "./githubState";

describe("selectAutomaticBackupRepo", () => {
  const repo = (name: string): BackupRepository => ({
    name,
    fullName: `user/${name}`,
    url: `https://github.com/user/${name}.git`,
  });

  it("prefers the configured repository name", () => {
    assert.equal(
      selectAutomaticBackupRepo([repo("old"), repo("preferred")], "preferred")?.name,
      "preferred"
    );
  });

  it("automatically selects the only discovered backup", () => {
    assert.equal(selectAutomaticBackupRepo([repo("renamed")], "missing")?.name, "renamed");
  });

  it("requires a choice when multiple backups have no preferred match", () => {
    assert.equal(selectAutomaticBackupRepo([repo("a"), repo("b")], "missing"), undefined);
  });

  // 個人與組織底下可能各有一個同名備份庫，猜錯就接到別人的備份庫。
  it("requires a choice when the preferred name exists under several owners", () => {
    const personal = repo("shared");
    const org = { ...repo("shared"), fullName: "acme/shared" };
    assert.equal(selectAutomaticBackupRepo([personal, org], "shared"), undefined);
  });
});

describe("parseGithubRepo", () => {
  it("reads owner/repo from the URL forms git writes into origin", () => {
    for (const url of [
      "https://github.com/acme/backup.git",
      "https://github.com/acme/backup",
      "https://x-access-token@github.com/acme/backup.git",
      "git@github.com:acme/backup.git",
      "ssh://git@github.com:2222/acme/backup.git",
    ]) {
      assert.equal(parseGithubRepo(` ${url} `)?.fullName, "acme/backup");
    }
  });

  // 刪除是不可逆的操作，認錯主機等於刪到別人的儲存庫。
  it("refuses hosts that merely look like github.com", () => {
    for (const url of [
      "https://gitlab.example.com/acme/backup.git",
      "https://mygithub.com/acme/backup.git",
      "https://user@mygithub.com/acme/backup.git",
      "https://github.example.com/acme/backup.git",
      "https://github.com/acme",
      "",
    ]) {
      assert.equal(parseGithubRepo(url), undefined);
    }
  });
});

describe("normalizeRemoteInput", () => {
  it("accepts the URL forms git understands", () => {
    for (const url of [
      "https://gitlab.example.com/team/backup.git",
      "ssh://git@example.com:2222/team/backup.git",
      "git@github.com:acme/backup.git",
      "D:\\shared\\backup.git",
      "/srv/git/backup.git",
    ]) {
      assert.equal(normalizeRemoteInput(` ${url} `), url);
    }
  });

  it("rejects anything git would not resolve", () => {
    for (const value of ["", "   ", "backup", "https://", "example.com/team/backup"]) {
      assert.equal(normalizeRemoteInput(value), undefined);
    }
  });
});
