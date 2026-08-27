import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { disambiguateLabels, LabelCandidate } from "./projectLabels";

function labels(candidates: LabelCandidate[]): string[] {
  const map = disambiguateLabels(candidates);
  return candidates.map((candidate) => map.get(candidate.key)!);
}

describe("disambiguateLabels", () => {
  it("shows only the folder name when nothing collides", () => {
    assert.deepEqual(
      labels([
        { key: "a", label: "App", cwd: "C:\\Work\\App", id: "git-a" },
        { key: "b", label: "Other", cwd: "C:\\Work\\Other", id: "git-b" },
      ]),
      ["App", "Other"]
    );
  });

  it("adds one path segment to each side of a collision", () => {
    assert.deepEqual(
      labels([
        { key: "a", label: "api", cwd: "C:\\work\\api", id: "git-a" },
        { key: "b", label: "api", cwd: "C:\\personal\\api", id: "git-b" },
      ]),
      ["work\\api", "personal\\api"]
    );
  });

  it("keeps extending until the labels actually differ", () => {
    assert.deepEqual(
      labels([
        { key: "a", label: "api", cwd: "/srv/one/svc/api", id: "git-a" },
        { key: "b", label: "api", cwd: "/srv/two/svc/api", id: "git-b" },
      ]),
      ["one/svc/api", "two/svc/api"]
    );
  });

  it("separates same-named projects on different drives", () => {
    assert.deepEqual(
      labels([
        { key: "a", label: "App", cwd: "C:\\App", id: "git-a" },
        { key: "b", label: "App", cwd: "D:\\App", id: "git-b" },
      ]),
      ["C:\\App", "D:\\App"]
    );
  });

  it("never disambiguates two paths of the same project", () => {
    // 同一個 id 就是同一個專案，把標籤改得不一樣等於宣稱它們是不同的東西。
    assert.deepEqual(
      labels([
        { key: "a", label: "SessionBackup", cwd: "C:\\GitHub\\SessionBackup", id: "git-x" },
        { key: "b", label: "SessionBackup", cwd: "D:\\GitHub\\SessionBackup", id: "git-x" },
      ]),
      ["SessionBackup", "SessionBackup"]
    );
  });

  it("falls back to the machine name when the paths are identical", () => {
    assert.deepEqual(
      labels([
        {
          key: "a",
          label: "api",
          cwd: "C:\\dev\\api",
          id: "git-a",
          machines: ["ST-A"],
        },
        {
          key: "b",
          label: "api",
          cwd: "C:\\dev\\api",
          id: "git-b",
          machines: ["ST-B"],
        },
      ]),
      ["C:\\dev\\api (ST-A)", "C:\\dev\\api (ST-B)"]
    );
  });

  it("uses the machine name for entries that have no path at all", () => {
    assert.deepEqual(
      labels([
        { key: "a", label: "api", id: "git-a", machines: ["ST-A"] },
        { key: "b", label: "api", id: "git-b", machines: ["ST-B"] },
      ]),
      ["api (ST-A)", "api (ST-B)"]
    );
  });

  it("resolves a collision created by extending a third project", () => {
    // a 與 b 撞名 → 各補一段 → a 變成 "work\\api"，剛好撞到 c，兩者要再往上補。
    // b 補成 "svc\\api" 就已經唯一，不必陪著繼續補——每一筆只補到分得開為止。
    assert.deepEqual(
      labels([
        { key: "a", label: "api", cwd: "C:\\one\\work\\api", id: "git-a" },
        { key: "b", label: "api", cwd: "C:\\two\\svc\\api", id: "git-b" },
        { key: "c", label: "work\\api", cwd: "C:\\three\\work\\api", id: "git-c" },
      ]),
      ["one\\work\\api", "svc\\api", "three\\work\\api"]
    );
  });
});
