import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { configReaction, RECONFIGURE_KEYS } from "./configChange";

/** 模擬 vscode 的 affectsConfiguration：只有前綴相符的設定才算受影響。 */
const changed = (...keys: string[]) => (key: string) =>
  keys.some((k) => k === key || k.startsWith(key + "."));

describe("configReaction", () => {
  it("reloads the selection and restarts the timer when the selection changes", () => {
    // 勾選變更不該重建 watcher：它只縮放本機掃描範圍。
    assert.deepEqual(configReaction(changed("sessionBackup.trackedSessions")), {
      reloadSelection: true,
      reconfigure: false,
      restartTimer: true,
    });
  });

  it("reconfigures for exactly the watch-target and remote settings", () => {
    // 逐一列出而不是走訪 RECONFIGURE_KEYS：拿被測的常數當預期值，
    // 少掉一個 key 時測試會跟著少驗一項，改壞了也不會失敗。
    assert.deepEqual(RECONFIGURE_KEYS, [
      "sessionBackup.sources",
      "sessionBackup.repoPath",
      "sessionBackup.repoName",
      "sessionBackup.machineId",
    ]);
  });

  it("reconfigures when a watch target or remote changes", () => {
    for (const key of RECONFIGURE_KEYS) {
      // 這些 key 都在 sessionBackup 底下，因此也一定會重設計時器。
      assert.deepEqual(
        configReaction(changed(key)),
        { reloadSelection: false, reconfigure: true, restartTimer: true },
        `${key} 的反應不如預期`,
      );
    }
  });

  it("does not reconfigure for an unrelated sessionBackup setting", () => {
    assert.deepEqual(configReaction(changed("sessionBackup.autoBackupMinutes")), {
      reloadSelection: false,
      reconfigure: false,
      restartTimer: true,
    });
  });

  it("ignores settings belonging to other extensions", () => {
    assert.deepEqual(configReaction(changed("editor.fontSize")), {
      reloadSelection: false,
      reconfigure: false,
      restartTimer: false,
    });
  });
});
