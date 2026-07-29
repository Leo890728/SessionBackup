import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { placeholderFor, redactText, restoreText } from "./redact";
import { PATTERNS } from "./secretScan";

const GITHUB = "ghp_" + "a".repeat(36);
const OPENAI = "sk-proj-" + "b".repeat(40);

describe("redactText", () => {
  it("replaces a credential with a content-derived placeholder", () => {
    const { text, redactions } = redactText(`token is ${GITHUB} ok`);
    assert.equal(text, `token is ${placeholderFor("github", GITHUB)} ok`);
    assert.equal(redactions.length, 1);
    assert.equal(redactions[0].secret, GITHUB);
    assert.equal(redactions[0].kind, "GitHub token");
  });

  it("is deterministic across runs and independent of scan order", () => {
    // 跨機一致是硬需求：兩台各自遮出來的位元組必須完全相同，否則變成永久假衝突。
    const a = redactText(`x ${OPENAI} y ${GITHUB}`);
    const b = redactText(`x ${OPENAI} y ${GITHUB}`);
    assert.equal(a.text, b.text);
    assert.equal(redactText(GITHUB).text, redactText(`${OPENAI}\n${GITHUB}`).text.split("\n")[1]);
  });

  it("is idempotent — placeholders are not themselves matched", () => {
    const once = redactText(`key ${OPENAI}`).text;
    assert.equal(redactText(once).text, once);
    assert.deepEqual(redactText(once).redactions, []);
  });

  it("records each distinct secret once but replaces every occurrence", () => {
    const { text, redactions } = redactText(`${GITHUB} and again ${GITHUB}`);
    assert.equal(redactions.length, 1);
    assert.equal(text.split(placeholderFor("github", GITHUB)).length - 1, 2);
  });

  it("reports the line each secret was found on", () => {
    const { redactions } = redactText(`line1\nline2\nkey ${GITHUB}\nline4`);
    assert.equal(redactions[0].line, 3);
  });

  it("masks only the password inside a connection string", () => {
    const { text, redactions } = redactText(
      "postgres://admin:hunter2supersecret@db.internal:5432/app"
    );
    assert.match(text, /^postgres:\/\/admin:<SECRET:db-url:[0-9a-f]{8}>@db\.internal:5432\/app$/);
    assert.equal(redactions[0].secret, "hunter2supersecret");
  });

  it("does not let overlapping rules nest replacements", () => {
    // sk-proj- 同時可能被舊版 sk- 規則掃到，長的必須贏，且只取代一次。
    const { text, redactions } = redactText(OPENAI);
    assert.equal(redactions.length, 1);
    assert.match(text, /^<SECRET:openai:[0-9a-f]{8}>$/);
  });

  it("leaves ordinary high-entropy strings alone", () => {
    // 沒有前綴錨定就不該動它：sha、UUID、base64 在對話裡到處都是。
    const text =
      "sha256:9d3978b05125c5e298bc54f67c11cd2e65b857aef5099688fbd41bb9c0190c31\n" +
      "id 2b73b38b-3039-4210-8604-0054b17a8f12\n" +
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk";
    assert.deepEqual(redactText(text), { text, redactions: [] });
  });

  it("keeps every line valid JSON", () => {
    const line = JSON.stringify({ type: "message", text: `use ${GITHUB} now` });
    const { text } = redactText(line);
    const parsed = JSON.parse(text);
    assert.equal(parsed.text, `use ${placeholderFor("github", GITHUB)} now`);
  });
});

describe("restoreText", () => {
  it("is an exact inverse of redactText", () => {
    const original = `a ${GITHUB} b ${OPENAI} c ${GITHUB}`;
    const { text, redactions } = redactText(original);
    const { text: back, restored } = restoreText(text, redactions);
    assert.equal(back, original);
    assert.equal(restored, 3);
  });

  it("reports zero when nothing matches", () => {
    const { restored } = restoreText("nothing here", [
      { placeholder: "<SECRET:github:deadbeef>", secret: GITHUB },
    ]);
    assert.equal(restored, 0);
  });
});

describe("PATTERNS", () => {
  it("uses stable slugs and no global flags", () => {
    for (const pattern of PATTERNS) {
      assert.match(pattern.slug, /^[a-z0-9-]+$/, `slug: ${pattern.slug}`);
      assert.equal(pattern.re.global, false, `global flag on ${pattern.kind}`);
    }
  });

  it("matches the credential formats it claims to", () => {
    const samples: [string, string][] = [
      ["sk-ant-" + "a".repeat(20), "anthropic"],
      [OPENAI, "openai"],
      [GITHUB, "github"],
      ["glpat-" + "a".repeat(20), "gitlab"],
      ["AKIA" + "A".repeat(16), "aws"],
      ["xoxb-" + "1".repeat(12), "slack"],
      ["AIza" + "a".repeat(35), "google"],
      ["sk_live_" + "a".repeat(20), "stripe"],
      ["npm_" + "a".repeat(36), "npm"],
      ["hf_" + "a".repeat(34), "hf"],
      ["gsk_" + "a".repeat(40), "groq"],
      ["ntn_" + "a".repeat(40), "notion"],
      ["eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.dBjftJeZ4CVP", "jwt"],
    ];
    for (const [sample, slug] of samples) {
      const { text, redactions } = redactText(sample);
      assert.equal(redactions.length, 1, `no match for ${slug}`);
      assert.equal(text, placeholderFor(slug, sample), `wrong slug for ${slug}`);
    }
  });
});
