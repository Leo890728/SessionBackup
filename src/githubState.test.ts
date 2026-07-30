import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BackupRepository,
  normalizeRemoteInput,
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
