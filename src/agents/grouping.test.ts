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

  it("sinks projects without a local folder below the local ones", () => {
    const groups = groupSessionProjects(
      [],
      [
        // 從別台電腦同步回來的：mtime 最新，但本機沒有這個資料夾。
        codex("remote", "D:\\Work\\RPG", 900),
        codex("local", "C:\\Work\\App", 100),
      ],
      (cwd) => cwd?.toLowerCase().startsWith("c:") ?? true
    );

    assert.deepEqual(
      groups.map((group) => [group.label, group.local]),
      [
        ["App", true],
        ["RPG", false],
      ]
    );
  });

  it("asks the caller about every project, including ones without a cwd", () => {
    const asked: (string | undefined)[] = [];
    const groups = groupSessionProjects([], [codex("blank", undefined, 100)], (cwd) => {
      asked.push(cwd);
      return false;
    });

    assert.deepEqual(asked, [undefined]);
    assert.equal(groups[0].key, "missing:");
    assert.equal(groups[0].local, false);
  });

  it("merges two paths of one project and fronts the local one", () => {
    // 同一個專案在兩台電腦的路徑不同：同步回來的檔案帶著來源電腦的 cwd，
    // 光看路徑是兩組，認得出身分就該併成一組。
    const isLocal = (cwd: string | undefined) =>
      cwd?.toLowerCase().startsWith("d:") ?? true;
    const groups = groupSessionProjects(
      [],
      [codex("imported", "C:\\Work\\App", 300), codex("native", "D:\\Work\\App", 100)],
      isLocal,
      () => "git-same"
    );

    assert.equal(groups.length, 1);
    assert.equal(groups[0].key, "windows:d:\\work\\app");
    assert.equal(groups[0].cwd, "D:\\Work\\App");
    assert.equal(groups[0].local, true);
    assert.equal(groups[0].latestMtime, 300);
    assert.deepEqual(groups[0].strayCwdKeys, ["windows:c:\\work\\app"]);
    assert.deepEqual(
      groups[0].ai[0].tool === "codex"
        ? groups[0].ai[0].sessions.map((s) => s.id)
        : [],
      ["imported", "native"]
    );
  });

  it("reports its own path as stray when nothing local shares the identity", () => {
    const groups = groupSessionProjects(
      [],
      [codex("imported", "C:\\Work\\App", 300)],
      () => false,
      () => "git-same"
    );

    assert.equal(groups[0].local, false);
    assert.deepEqual(groups[0].strayCwdKeys, ["windows:c:\\work\\app"]);
  });

  it("leaves paths apart when the caller cannot identify them", () => {
    const groups = groupSessionProjects(
      [],
      [codex("a", "C:\\Work\\App", 300), codex("b", "D:\\Work\\App", 100)],
      () => true
    );

    assert.equal(groups.length, 2);
    assert.deepEqual(
      groups.flatMap((group) => group.strayCwdKeys),
      []
    );
  });

  it("does not merge two projects with different identities", () => {
    const id = new Map([
      ["windows:c:\\work\\app", "git-one"],
      ["windows:d:\\work\\app", "git-two"],
    ]);
    const groups = groupSessionProjects(
      [],
      [codex("a", "C:\\Work\\App", 300), codex("b", "D:\\Work\\App", 100)],
      () => true,
      (key) => id.get(key)
    );

    assert.equal(groups.length, 2);
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
