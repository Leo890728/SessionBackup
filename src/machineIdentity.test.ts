import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it } from "node:test";
import {
  applyMachineIdentity,
  deriveMachineId,
  detectLegacyMachineId,
  MachineIdentityStore,
  migrateMachineDirectory,
} from "./machineIdentity";

describe("deriveMachineId", () => {
  it("keeps the hostname readable and appends a stable suffix", () => {
    const id = deriveMachineId("LAPTOP-8KJ2IV08", "install-abc");
    assert.match(id, /^LAPTOP-8KJ2IV08-[0-9a-f]{6}$/);
    assert.equal(id, deriveMachineId("LAPTOP-8KJ2IV08", "install-abc"));
  });

  it("separates two machines sharing a hostname", () => {
    assert.notEqual(
      deriveMachineId("DESKTOP-PC", "install-a"),
      deriveMachineId("DESKTOP-PC", "install-b")
    );
  });

  it("sanitizes characters that cannot be a directory segment", () => {
    assert.ok(!deriveMachineId("host name/../x", "install").includes("/"));
  });

  it("falls back to the hostname alone when no installation id is available", () => {
    assert.equal(deriveMachineId("HOST", ""), "HOST");
  });
});

function repo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "machine-id-"));
}

function writeManifest(root: string, id: string): void {
  const dir = path.join(root, "machines", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ formatVersion: 2, machineId: id, sessions: [] }),
    "utf8"
  );
  fs.writeFileSync(path.join(dir, "resolutions.json"), "{}", "utf8");
}

describe("migrateMachineDirectory", () => {
  it("renames the old directory and rewrites the manifest machineId", async () => {
    const root = repo();
    writeManifest(root, "OLD");

    assert.equal(await migrateMachineDirectory(root, "OLD", "NEW-abc123"), "renamed");
    assert.ok(!fs.existsSync(path.join(root, "machines", "OLD")));

    const moved = path.join(root, "machines", "NEW-abc123");
    // 保留本機的決定跟著搬過去，不然使用者的選擇會失效。
    assert.ok(fs.existsSync(path.join(moved, "resolutions.json")));
    const manifest = JSON.parse(fs.readFileSync(path.join(moved, "manifest.json"), "utf8"));
    assert.equal(manifest.machineId, "NEW-abc123");
  });

  it("does nothing when the id has not changed", async () => {
    const root = repo();
    writeManifest(root, "SAME");
    assert.equal(await migrateMachineDirectory(root, "SAME", "SAME"), "none");
    assert.ok(fs.existsSync(path.join(root, "machines", "SAME", "manifest.json")));
  });

  it("does nothing when there is no previous id", async () => {
    const root = repo();
    assert.equal(await migrateMachineDirectory(root, undefined, "NEW"), "none");
  });

  it("refuses to overwrite an existing directory for the new id", async () => {
    const root = repo();
    writeManifest(root, "OLD");
    writeManifest(root, "NEW");

    assert.equal(await migrateMachineDirectory(root, "OLD", "NEW"), "blocked");
    // 兩邊都留著，讓使用者自己判斷是不是同一台電腦。
    assert.ok(fs.existsSync(path.join(root, "machines", "OLD", "manifest.json")));
    const kept = JSON.parse(
      fs.readFileSync(path.join(root, "machines", "NEW", "manifest.json"), "utf8")
    );
    assert.equal(kept.machineId, "NEW");
  });
});

describe("detectLegacyMachineId", () => {
  it("finds the pre-0.2.1 bare-hostname directory", () => {
    const root = repo();
    writeManifest(root, "ST-LZY");
    assert.equal(detectLegacyMachineId(root, "ST-LZY", "ST-LZY-3f9a2c"), "ST-LZY");
  });

  it("ignores a legacy id with no directory in the store", () => {
    assert.equal(detectLegacyMachineId(repo(), "ST-LZY", "ST-LZY-3f9a2c"), undefined);
  });

  it("ignores a legacy id equal to the current one", () => {
    const root = repo();
    writeManifest(root, "ST-LZY");
    assert.equal(detectLegacyMachineId(root, "ST-LZY", "ST-LZY"), undefined);
  });
});

describe("applyMachineIdentity", () => {
  function storage(): MachineIdentityStore {
    return new MachineIdentityStore(fs.mkdtempSync(path.join(os.tmpdir(), "machine-store-")));
  }

  it("migrates the legacy directory on the first upgrade, then remembers the id", async () => {
    const root = repo();
    const store = storage();
    writeManifest(root, "ST-LZY");

    const first = await applyMachineIdentity(store, root, "ST-LZY-3f9a2c", "ST-LZY");
    assert.equal(first.result, "renamed");
    assert.equal(first.from, "ST-LZY");
    assert.equal(await store.lastUsed(), "ST-LZY-3f9a2c");

    // 第二次啟動已經有紀錄，不該再搬任何東西。
    const second = await applyMachineIdentity(store, root, "ST-LZY-3f9a2c", "ST-LZY");
    assert.equal(second.result, "none");
  });

  it("keeps the previous id recorded when migration is blocked", async () => {
    const root = repo();
    const store = storage();
    await store.remember("OLD");
    writeManifest(root, "OLD");
    writeManifest(root, "NEW");

    const applied = await applyMachineIdentity(store, root, "NEW");
    assert.equal(applied.result, "blocked");
    // 還沒搬成功就記下新 id 的話，下次啟動會忘記還有舊目錄要處理。
    assert.equal(await store.lastUsed(), "OLD");
  });
});
