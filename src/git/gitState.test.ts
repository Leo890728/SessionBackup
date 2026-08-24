import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectFetchedRemoteBranch } from "./gitState";

describe("selectFetchedRemoteBranch", () => {
  it("uses an existing preferred branch", () => {
    assert.equal(selectFetchedRemoteBranch(["origin/main"], "main"), "main");
  });

  it("falls back from local main to the existing remote master branch", () => {
    assert.equal(selectFetchedRemoteBranch(["origin/master"], "main"), "master");
  });

  it("ignores origin/HEAD and supports a custom branch", () => {
    assert.equal(
      selectFetchedRemoteBranch(["origin/HEAD", "origin/backup"], "main"),
      "backup"
    );
  });
});
