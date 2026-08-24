import * as assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { groupCodexProjects, groupSessionProjects } from "./grouping";

describe("groupCodexProjects", () => {
  const info = (id: string, cwd: string | undefined, mtime: number) => ({
    tool: "codex" as const,
    file: `${id}.jsonl`,
    id,
    backupId: id,
    mtime,
    size: 1,
    title: id,
    cwd,
    date: mtime >= 200 ? "2026-07-15" : "2026-07-14",
    time: "10:00",
  });

  it("groups sessions across dates by normalized Windows cwd", () => {
    const oldSession = info("old", "C:\\Work\\App", 100);
    const newestSession = info("new", "c:/work/app/", 300);
    const otherProject = info("other", "D:\\Repos\\Other", 200);

    const groups = groupCodexProjects([oldSession, otherProject, newestSession]);

    assert.equal(groups.length, 2);
    assert.deepEqual(
      groups.map((group) => group.label),
      ["App", "Other"]
    );
    assert.equal(groups[0].key, "windows:c:\\work\\app");
    assert.equal(groups[0].cwd, "C:\\Work\\App");
    assert.deepEqual(
      groups[0].sessions.map((session) => session.id),
      ["new", "old"]
    );
  });

  it("keeps identical basenames from different cwd values separate", () => {
    const groups = groupCodexProjects([
      info("one", "/work/one/app", 200),
      info("two", "/work/two/app/", 100),
    ]);

    assert.equal(groups.length, 2);
    assert.deepEqual(
      groups.map((group) => [group.key, group.label]),
      [
        ["posix:/work/one/app", "app"],
        ["posix:/work/two/app", "app"],
      ]
    );
  });

  it("puts missing and blank cwd values in one fallback group", () => {
    const groups = groupCodexProjects([
      info("missing", undefined, 100),
      info("blank", "   ", 200),
    ]);

    assert.equal(groups.length, 1);
    assert.equal(groups[0].key, "missing:");
    assert.equal(groups[0].label, "未識別專案");
    assert.equal(groups[0].cwd, undefined);
    assert.deepEqual(
      groups[0].sessions.map((session) => session.id),
      ["blank", "missing"]
    );
  });
});

describe("groupSessionProjects", () => {
  const codex = (id: string, cwd: string | undefined, mtime: number) => ({
    tool: "codex" as const,
    file: `${id}.jsonl`,
    id,
    backupId: id,
    mtime,
    size: 1,
    title: id,
    cwd,
    date: "2026-07-14",
    time: "10:00",
  });
  const claude = (cwd: string | undefined, mtime: number) => ({
    dir: path.join("claude-projects", "C--Work-App"),
    label: "App",
    cwd,
    decoded: cwd ?? "C:\\Work\\App",
    mtime,
    count: 1,
    sessionIds: ["claude-1"],
  });

  it("merges Claude and Codex under one project with fixed AI order", () => {
    const groups = groupSessionProjects(
      [claude("C:\\Work\\App", 200)],
      [codex("codex-1", "c:/work/app/", 300)]
    );

    assert.equal(groups.length, 1);
    assert.equal(groups[0].key, "windows:c:\\work\\app");
    assert.equal(groups[0].latestMtime, 300);
    assert.deepEqual(
      groups[0].ai.map((group) => group.tool),
      ["claude", "codex"]
    );
  });

  it("keeps a Claude bucket without trusted cwd separate from missing Codex cwd", () => {
    const groups = groupSessionProjects(
      [claude(undefined, 100)],
      [codex("codex-1", undefined, 200)]
    );

    assert.deepEqual(
      groups.map((group) => [group.key, group.ai.map((ai) => ai.tool)]),
      [
        ["missing:", ["codex"]],
        ["claudeBucket:c--work-app", ["claude"]],
      ]
    );
  });
});
