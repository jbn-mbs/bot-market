import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { scrub } from "../src/modules/devmon/checks.js";
import { verifyGithub, verifyVercel } from "../src/modules/devmon/hooks.js";

test("scrub removes bearer tokens, JWTs and key=value secrets", () => {
  const out = scrub("Authorization: Bearer abc.def.ghi failed for url?api_key=sk-123&x=1 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig");
  assert.ok(!out.includes("abc.def.ghi"));
  assert.ok(!out.includes("sk-123"));
  assert.ok(!out.includes("eyJhbGci"));
});

test("webhook signatures verify and reject tampering", () => {
  process.env.GITHUB_WEBHOOK_SECRET = "gh";
  process.env.VERCEL_WEBHOOK_SECRET = "vc";
  const body = '{"a":1}';
  assert.ok(verifyGithub(body, `sha256=${createHmac("sha256", "gh").update(body).digest("hex")}`));
  assert.ok(!verifyGithub('{"a":2}', `sha256=${createHmac("sha256", "gh").update(body).digest("hex")}`));
  assert.ok(verifyVercel(body, createHmac("sha1", "vc").update(body).digest("hex")));
  assert.ok(!verifyVercel(body, null));
});
