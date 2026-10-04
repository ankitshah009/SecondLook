import assert from "node:assert/strict";
import test from "node:test";
import { extractPlans, getMastra } from "@/mastra";

test("registered extraction logger suppresses raw details and extraction returns a sanitized failure", async t => {
  const previousBase = process.env.NEON_AI_GATEWAY_BASE_URL;
  const previousToken = process.env.NEON_AI_GATEWAY_TOKEN;
  process.env.NEON_AI_GATEWAY_BASE_URL = "https://gateway.example";
  process.env.NEON_AI_GATEWAY_TOKEN = "test-only-token";
  try {
    const output: unknown[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      t.mock.method(console, method, (...values: unknown[]) => { output.push(values); });
    }
    const mastra = getMastra();
    mastra.getLogger().error("Private captured passage", { token: "test-only-token" });
    assert.deepEqual(output, [], "framework logging must not print raw provider details");
    let requests = 0;
    t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
      requests += 1;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.response_format, undefined, "do not send the Gateway-rejected native schema format");
      assert.equal(body.text?.format, undefined, "Responses requests must also use prompt JSON with local validation");
      return new Response(JSON.stringify({ error: { code: "credits_required", message: "Private captured passage", token: "test-only-token" } }), {
        status: 403, headers: { "Content-Type": "application/json" },
      });
    });
    await assert.rejects(extractPlans([], []), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /credit-related restriction \(HTTP 403\)/);
      assert.doesNotMatch(error.message, /test-only-token|Private captured passage/);
      return true;
    });
    assert.equal(requests, 1, "exercise the actual Mastra/provider path with only network I/O mocked");
    assert.deepEqual(output, []);
  } finally {
    if (previousBase === undefined) delete process.env.NEON_AI_GATEWAY_BASE_URL;
    else process.env.NEON_AI_GATEWAY_BASE_URL = previousBase;
    if (previousToken === undefined) delete process.env.NEON_AI_GATEWAY_TOKEN;
    else process.env.NEON_AI_GATEWAY_TOKEN = previousToken;
  }
});
