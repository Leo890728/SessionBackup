import * as assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { STORE_FORMAT_VERSION } from "../../store/sessionStore";
import {
  deleteRepository,
  ensurePrivateRepo,
  findBackupRepositories,
  listRepoOwners,
} from "./api";

const DESCRIPTION = "AI session backup (managed by VSCode Session Backup extension)";

interface Call {
  url: string;
  method: string;
  body?: any;
}

/**
 * 依序回應每個請求。回傳的 calls 讓測試檢查「有沒有發出這個請求」，
 * 例如既有的私人儲存庫不該再打建立 repo 的 POST。
 */
function stubFetch(responses: { status: number; json?: unknown }[]): Call[] {
  const calls: Call[] = [];
  let index = 0;
  (globalThis as any).fetch = async (url: string, init: any) => {
    calls.push({
      url,
      method: init.method,
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    const next = responses[index++];
    assert.ok(next, `沒有預備第 ${index} 個回應（${init.method} ${url}）`);
    return {
      status: next.status,
      json: async () => {
        if (!("json" in next)) {
          throw new Error("no body");
        }
        return next.json;
      },
    };
  };
  return calls;
}

const originalFetch = (globalThis as any).fetch;
afterEach(() => {
  (globalThis as any).fetch = originalFetch;
});

const contents = (value: unknown) => ({
  status: 200,
  json: {
    encoding: "base64",
    content: Buffer.from(JSON.stringify(value), "utf8").toString("base64"),
  },
});

const repo = (over: Record<string, unknown> = {}) => ({
  private: true,
  name: "agent-session-backup",
  full_name: "me/agent-session-backup",
  clone_url: "https://github.com/me/agent-session-backup.git",
  description: DESCRIPTION,
  ...over,
});

describe("listRepoOwners", () => {
  it("puts the authenticated user first and appends their orgs", async () => {
    stubFetch([
      { status: 200, json: { login: "me" } },
      { status: 200, json: [{ login: "acme" }, { login: "globex" }] },
    ]);
    assert.deepEqual(await listRepoOwners("t"), [
      { login: "me", kind: "user" },
      { login: "acme", kind: "org" },
      { login: "globex", kind: "org" },
    ]);
  });

  it("still returns the user when the org list is refused", async () => {
    // token 未對組織授權 SSO 時 /user/orgs 會失敗，但個人帳號仍可用。
    stubFetch([{ status: 200, json: { login: "me" } }, { status: 403 }]);
    assert.deepEqual(await listRepoOwners("t"), [{ login: "me", kind: "user" }]);
  });

  it("skips org entries without a login", async () => {
    stubFetch([
      { status: 200, json: { login: "me" } },
      { status: 200, json: [{ login: "acme" }, {}, { login: 7 }] },
    ]);
    assert.deepEqual(await listRepoOwners("t"), [
      { login: "me", kind: "user" },
      { login: "acme", kind: "org" },
    ]);
  });

  it("throws when the user lookup fails", async () => {
    stubFetch([{ status: 401 }]);
    await assert.rejects(listRepoOwners("t"), /HTTP 401/);
  });
});

describe("ensurePrivateRepo", () => {
  const user = { login: "me", kind: "user" } as const;

  it("reuses an existing private repo without creating one", async () => {
    const calls = stubFetch([
      { status: 200, json: { private: true, clone_url: "https://git/me/backup.git" } },
    ]);
    assert.deepEqual(await ensurePrivateRepo("t", user, "backup"), {
      fullName: "me/backup",
      url: "https://git/me/backup.git",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "GET");
  });

  it("refuses an existing public repo", async () => {
    stubFetch([{ status: 200, json: { private: false } }]);
    await assert.rejects(ensurePrivateRepo("t", user, "backup"), /不是私人的/);
  });

  it("creates a private repo under the user when none exists", async () => {
    const calls = stubFetch([
      { status: 404 },
      { status: 201, json: { clone_url: "https://git/me/backup.git" } },
    ]);
    await ensurePrivateRepo("t", user, "backup");
    assert.match(calls[1].url, /\/user\/repos$/);
    assert.equal(calls[1].method, "POST");
    assert.deepEqual(calls[1].body, {
      name: "backup",
      private: true,
      description: DESCRIPTION,
    });
  });

  it("creates under the org endpoint for an org owner", async () => {
    const calls = stubFetch([
      { status: 404 },
      { status: 201, json: { clone_url: "https://git/acme/backup.git" } },
    ]);
    await ensurePrivateRepo("t", { login: "acme", kind: "org" }, "backup");
    assert.match(calls[1].url, /\/orgs\/acme\/repos$/);
  });

  it("throws when the existence check itself fails", async () => {
    stubFetch([{ status: 500 }]);
    await assert.rejects(ensurePrivateRepo("t", user, "backup"), /HTTP 500/);
  });

  it("surfaces the API error body when creation fails", async () => {
    stubFetch([{ status: 404 }, { status: 422, json: { message: "name already exists" } }]);
    await assert.rejects(ensurePrivateRepo("t", user, "backup"), /name already exists/);
  });
});

describe("findBackupRepositories", () => {
  it("accepts a repo whose format.json matches the store format", async () => {
    stubFetch([
      { status: 200, json: [repo()] },
      contents({ format: "ai-session-store", version: STORE_FORMAT_VERSION }),
    ]);
    assert.deepEqual(await findBackupRepositories("t", "agent-session-backup"), [
      {
        name: "agent-session-backup",
        fullName: "me/agent-session-backup",
        url: "https://github.com/me/agent-session-backup.git",
      },
    ]);
  });

  it("rejects a store written by a different format version", async () => {
    stubFetch([
      { status: 200, json: [repo()] },
      contents({ format: "ai-session-store", version: STORE_FORMAT_VERSION + 1 }),
    ]);
    assert.deepEqual(await findBackupRepositories("t", "agent-session-backup"), []);
  });

  it("rejects a repo whose format.json is not valid JSON", async () => {
    stubFetch([
      { status: 200, json: [repo()] },
      {
        status: 200,
        json: { encoding: "base64", content: Buffer.from("{", "utf8").toString("base64") },
      },
    ]);
    assert.deepEqual(await findBackupRepositories("t", "agent-session-backup"), []);
  });

  it("rejects a format.json GitHub did not return as base64", async () => {
    // 檔案過大時 GitHub 回 encoding: "none" 且不附內容，不能當成通過驗證。
    stubFetch([
      { status: 200, json: [repo()] },
      {
        status: 200,
        json: {
          encoding: "none",
          content: Buffer.from(
            JSON.stringify({ format: "ai-session-store", version: STORE_FORMAT_VERSION }),
            "utf8"
          ).toString("base64"),
        },
      },
    ]);
    assert.deepEqual(await findBackupRepositories("t", "agent-session-backup"), []);
  });

  it("accepts an empty repo that still carries the backup description", async () => {
    // 剛建立、還沒推過 format.json 的備份庫仍要能被選到。
    stubFetch([{ status: 200, json: [repo()] }, { status: 404 }]);
    assert.equal((await findBackupRepositories("t", "agent-session-backup")).length, 1);
  });

  it("rejects an empty repo that only matched on the preferred name", async () => {
    stubFetch([
      { status: 200, json: [repo({ description: "something else" })] },
      { status: 404 },
    ]);
    assert.deepEqual(await findBackupRepositories("t", "agent-session-backup"), []);
  });

  it("matches on the preferred name when the description differs", async () => {
    stubFetch([
      { status: 200, json: [repo({ description: "my own notes" })] },
      contents({ format: "ai-session-store", version: STORE_FORMAT_VERSION }),
    ]);
    assert.equal((await findBackupRepositories("t", "agent-session-backup")).length, 1);
  });

  it("ignores public repos and unrelated names without probing them", async () => {
    const calls = stubFetch([
      {
        status: 200,
        json: [repo({ private: false }), repo({ name: "notes", description: "notes" })],
      },
    ]);
    assert.deepEqual(await findBackupRepositories("t", "agent-session-backup"), []);
    assert.equal(calls.length, 1, "不相關的儲存庫不該再打 format.json");
  });

  it("throws when the repo listing fails", async () => {
    stubFetch([{ status: 500 }]);
    await assert.rejects(findBackupRepositories("t", "backup"), /HTTP 500/);
  });
});

describe("deleteRepository", () => {
  it("resolves on 204", async () => {
    stubFetch([{ status: 204 }]);
    await deleteRepository("t", "me/backup");
  });

  it("explains a missing delete_repo scope on 403", async () => {
    stubFetch([{ status: 403 }]);
    await assert.rejects(deleteRepository("t", "me/backup"), /delete_repo/);
  });

  it("explains a 404 as already gone or invisible", async () => {
    stubFetch([{ status: 404 }]);
    await assert.rejects(deleteRepository("t", "me/backup"), /404/);
  });

  it("surfaces any other status with the API message", async () => {
    stubFetch([{ status: 500, json: { message: "server error" } }]);
    await assert.rejects(deleteRepository("t", "me/backup"), /server error/);
  });
});
