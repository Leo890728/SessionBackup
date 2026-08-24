import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractUserContext } from "./transcriptText";

describe("extractUserContext", () => {
  it("pulls the opened file out of the question", () => {
    const { contexts, rest } = extractUserContext(
      "<ide_opened_file>The user opened the file d:\\work\\App\\project.md in the IDE. " +
        "This may or may not be related to the current task.</ide_opened_file>\n" +
        "規劃討論還有一個問題"
    );
    assert.deepEqual(contexts, [{ label: "開啟檔案", detail: "d:\\work\\App\\project.md" }]);
    assert.equal(rest, "規劃討論還有一個問題");
  });

  it("drops injected system reminders anywhere in the text", () => {
    const { contexts, rest } = extractUserContext(
      "先做 A\n<system-reminder>這是注入的提醒</system-reminder>\n再做 B"
    );
    assert.deepEqual(contexts, []);
    assert.equal(rest, "先做 A\n\n再做 B");
  });

  it("reports an empty question when only IDE context was sent", () => {
    const { contexts, rest } = extractUserContext(
      "<ide_selection>selected lines in d:\\work\\a.ts</ide_selection>"
    );
    assert.equal(contexts.length, 1);
    assert.equal(rest, "");
  });
});
