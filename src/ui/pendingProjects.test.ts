import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RemoteProject } from "../store/unmappedProjects";
import { splitPendingProjects } from "./pendingProjects";
import { ProjectNode } from "./treeNodes";

const GIS: RemoteProject["project"] = {
  id: "local-abc",
  displayName: "GIS",
};
const OTHER: RemoteProject["project"] = { id: "git-other", displayName: "Other" };

function projectNode(over: Partial<ProjectNode> = {}): ProjectNode {
  return {
    kind: "project",
    key: "windows:c:\\dev\\gis",
    label: "GIS",
    cwd: "C:\\dev\\gis",
    latestMtime: 1,
    local: false,
    backedUp: true,
    strayCwdKeys: ["windows:c:\\dev\\gis"],
    sessionKeys: [],
    children: [],
    ...over,
  };
}

/** 預設遠端這幾個對話本機都還沒有，所以 count 就是「還沒下來的數量」。 */
function remote(
  project: RemoteProject["project"],
  sessionKeys = ["codex:r1", "codex:r2", "claude:r3"],
  machines = ["A"]
): RemoteProject {
  return { project, count: sessionKeys.length, machines, sessionKeys };
}

describe("splitPendingProjects", () => {
  it("keeps resolvable projects out of the pending layer", () => {
    const local = projectNode({ local: true, key: "windows:d:\\ok", strayCwdKeys: [] });
    const { pending, mapped } = splitPendingProjects([local], []);
    assert.deepEqual(pending, []);
    assert.deepEqual(mapped, [local]);
  });

  it("merges the local codex node with the remote entry for the same project", () => {
    // 這是重點：同一個專案的 Codex（本機有檔案、cwd 指著來源電腦）與 Claude
    // （只在遠端 manifest 裡）以前會變成兩個節點。
    const { pending } = splitPendingProjects(
      [projectNode({ projectRef: GIS })],
      [remote(GIS, ["codex:r1", "codex:r2", "claude:r3", "claude:r4"], ["A", "C"])]
    );
    assert.equal(pending.length, 1);
    const [node] = pending;
    assert.equal(node.kind, "project");
    assert.equal(node.kind === "project" && node.projectRef?.id, GIS.id);
    assert.equal(node.kind === "project" && node.unmapped?.count, 4);
    assert.deepEqual(
      node.kind === "project" ? node.unmapped?.machines : undefined,
      ["A", "C"]
    );
  });

  it("counts only the conversations that are not on this machine yet", () => {
    // Codex 同步時不會被跳過，那些對話早就在本機了。把遠端總數寫進提示會和
    // 節點自己標的對話數對不起來——ECHA 標「19 個對話」卻說「備份過 11 個」。
    const { pending } = splitPendingProjects(
      [
        projectNode({
          projectRef: GIS,
          sessionKeys: ["codex:r1", "codex:r2"],
        }),
      ],
      [remote(GIS, ["codex:r1", "codex:r2", "claude:r3"])]
    );
    assert.equal(pending[0].kind === "project" && pending[0].unmapped?.count, 1);
  });

  it("says nothing about pending conversations when they are all here", () => {
    // 只剩工作目錄要修的情況：提示該講那件事，不是「還有 N 個沒下來」。
    const { pending } = splitPendingProjects(
      [
        projectNode({
          projectRef: GIS,
          sessionKeys: ["codex:r1", "codex:r2"],
        }),
      ],
      [remote(GIS, ["codex:r1", "codex:r2"])]
    );
    assert.equal(pending.length, 1);
    assert.equal(pending[0].kind === "project" && pending[0].unmapped, undefined);
    assert.equal(
      pending[0].kind === "project" && pending[0].projectRef?.id,
      GIS.id
    );
  });

  it("keeps the map action available once the remote entry is already resolved", () => {
    // 升級前就對應過的專案不會出現在 unmapped 清單裡，但本機那些 Codex 檔的
    // cwd 還指著來源電腦。節點得留著 projectRef + strayCwdKeys 才有得修。
    const { pending } = splitPendingProjects(
      [projectNode({ projectRef: GIS })],
      []
    );
    assert.equal(pending.length, 1);
    assert.equal(pending[0].kind === "project" && pending[0].unmapped, undefined);
    assert.equal(
      pending[0].kind === "project" && pending[0].projectRef?.id,
      GIS.id
    );
  });

  it("keeps the remote entry standalone when no local files match it", () => {
    const { pending } = splitPendingProjects([], [remote(GIS)]);
    assert.deepEqual(
      pending.map((node) => node.kind),
      ["unmappedProject"]
    );
  });

  it("leaves an unresolvable local project alone when nothing pending matches", () => {
    // 資料夾被移走或刪掉：沒有「對應」這件事可做，不該長出 unmapped 資訊。
    const { pending } = splitPendingProjects(
      [projectNode({ projectRef: OTHER })],
      [remote(GIS)]
    );
    assert.equal(pending.length, 2);
    assert.equal(pending[0].kind === "project" && pending[0].unmapped, undefined);
    assert.equal(pending[1].kind, "unmappedProject");
  });

  it("does not merge a project whose id was never resolved", () => {
    // projectRef 反查不到（來源電腦的 manifest 沒有這個 session）就別亂併。
    const { pending } = splitPendingProjects([projectNode()], [remote(GIS)]);
    assert.equal(pending.length, 2);
  });

  it("puts pending projects before the mapped ones", () => {
    const local = projectNode({ local: true, key: "windows:d:\\ok", strayCwdKeys: [] });
    const stray = projectNode({ projectRef: GIS });
    const { pending, mapped } = splitPendingProjects(
      [local, stray],
      [remote(GIS)]
    );
    assert.equal(pending.length, 1);
    assert.deepEqual(mapped, [local]);
  });
});
