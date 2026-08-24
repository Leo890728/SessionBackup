import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  codexOwnId,
  codexParentThreadId,
  codexSessionMeta,
  codexSubagentName,
  codexThreadId,
} from "./codexMeta";

describe("codexSessionMeta", () => {
  it("只認得帶 payload 物件的 session_meta", () => {
    assert.deepEqual(codexSessionMeta({ type: "session_meta", payload: { id: "a" } }), {
      id: "a",
    });
    assert.equal(codexSessionMeta({ type: "event_msg", payload: { id: "a" } }), undefined);
    assert.equal(codexSessionMeta({ type: "session_meta" }), undefined);
    assert.equal(codexSessionMeta({ type: "session_meta", payload: "字串" }), undefined);
    assert.equal(codexSessionMeta(undefined), undefined);
  });
});

describe("codexThreadId", () => {
  it("新版優先用 session_id，舊版退回 id", () => {
    assert.equal(codexThreadId({ session_id: "new", id: "old" }), "new");
    assert.equal(codexThreadId({ id: "old" }), "old");
  });

  it("欄位不是字串時視同缺欄位", () => {
    assert.equal(codexThreadId({ session_id: 42 }), undefined);
    assert.equal(codexThreadId({}), undefined);
  });
});

describe("codexOwnId / codexParentThreadId", () => {
  it("子代理檔的 thread id 是父，own id 才是自己", () => {
    const payload = {
      session_id: "parent-1",
      id: "own-1",
      parent_thread_id: "parent-1",
    };
    assert.equal(codexThreadId(payload), "parent-1");
    assert.equal(codexOwnId(payload), "own-1");
    assert.equal(codexParentThreadId(payload), "parent-1");
  });

  it("主 thread 沒有 parent_thread_id", () => {
    assert.equal(codexParentThreadId({ session_id: "t", id: "t" }), undefined);
  });
});

describe("codexSubagentName", () => {
  it("主 thread 的 source 不是子代理", () => {
    assert.equal(codexSubagentName("vscode"), undefined);
    assert.equal(codexSubagentName(undefined), undefined);
    assert.equal(codexSubagentName({}), undefined);
  });

  it("內建子代理取字串值", () => {
    assert.equal(codexSubagentName({ subagent: { other: "guardian" } }), "guardian");
    assert.equal(codexSubagentName({ subagent: "guardian" }), "guardian");
  });

  it("thread_spawn 取 agent_path 的最後一段，而不是 'thread_spawn'", () => {
    assert.equal(
      codexSubagentName({
        subagent: {
          thread_spawn: {
            parent_thread_id: "parent-1",
            depth: 1,
            agent_path: "/root/baseline_tests",
            agent_nickname: "Zeno",
            agent_role: null,
          },
        },
      }),
      "baseline_tests"
    );
  });

  it("沒有 agent_path 時退回 agent_nickname", () => {
    assert.equal(
      codexSubagentName({ subagent: { thread_spawn: { agent_nickname: "Zeno" } } }),
      "Zeno"
    );
  });

  it("形狀完全陌生時至少回傳鍵名，不會變成 undefined", () => {
    assert.equal(codexSubagentName({ subagent: { future_kind: { x: 1 } } }), "future_kind");
  });
});
