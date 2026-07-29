import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BackupRepository, selectAutomaticBackupRepo } from "./githubState";

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
});
