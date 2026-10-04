import assert from "node:assert/strict";
import test from "node:test";
import { describeGatewayFailure } from "@/lib/gateway-error";

test("classifies the SDK responseBody credit error and preserves HTTP status", () => {
  const result = describeGatewayFailure({
    name: "APICallError",
    statusCode: 403,
    responseBody: JSON.stringify({ error: "Insufficient credits for this Gateway request." }),
  });
  assert.equal(result.cause, "credits_exhausted");
  assert.equal(result.status, 403);
  assert.match(result.message, /credits are exhausted.*HTTP 403/i);
  assert.match(result.message, /NeonDB query access is separate/i);
});

test("reads message/name/cause from non-enumerable Error properties", () => {
  const inner = new Error("Account credit balance exhausted");
  const outer = new Error("Provider call failed", { cause: inner });
  Object.defineProperty(outer, "statusCode", { value: 403, enumerable: false });
  const result = describeGatewayFailure(outer);
  assert.equal(result.cause, "credits_exhausted");
  assert.equal(result.status, 403);
});

test("never echoes bearer tokens, URLs, emails, provider body, or arbitrary personal details", () => {
  const secret = "Bearer sk_live_topsecret";
  const privateUrl = "https://gateway.private.invalid/v1/request?token=hidden";
  const email = "customer@example.test";
  const result = describeGatewayFailure({
    status: 403,
    responseBody: JSON.stringify({ error: `Credit cap reached for ${email} at ${privateUrl}; ${secret}` }),
  });
  const output = JSON.stringify(result);
  assert.equal(result.cause, "credit_limit");
  assert.equal(result.status, 403);
  assert.doesNotMatch(output, /sk_live|topsecret|gateway\.private|token=hidden|customer@example\.test/i);
  assert.match(result.message, /credit or spending limit/i);
});

test("prefers credit cause over generic forbidden wording", () => {
  const result = describeGatewayFailure({
    statusCode: 403,
    message: "Forbidden: account credit balance is empty",
    cause: { status: 402, message: "No credits remain" },
  });
  assert.equal(result.cause, "credits_exhausted");
  assert.equal(result.status, 403);
});

test("keeps the outer HTTP status when a nested cause has its own status", () => {
  const result = describeGatewayFailure({
    statusCode: 403,
    cause: { status: 402, message: "Insufficient credits" },
  });
  assert.equal(result.cause, "credits_exhausted");
  assert.equal(result.status, 403);
});

test("reads HTTP status from a nested Response object", () => {
  const result = describeGatewayFailure({
    cause: { response: new Response(null, { status: 403 }), message: "Credit restriction" },
  });
  assert.equal(result.cause, "credit_restriction");
  assert.equal(result.status, 403);
});

test("classifies access, model, timeout and unknown failures without returning raw text", () => {
  const cases = [
    [{ statusCode: 401, message: "invalid token: raw-secret-value" }, "access"],
    [{ statusCode: 404, responseBody: JSON.stringify({ error: "Unknown model private-model-name" }) }, "model"],
    [{ name: "TimeoutError", message: "request timed out at https://private.invalid" }, "timeout"],
    [new DOMException("deadline exceeded", "TimeoutError"), "timeout"],
    [{ statusCode: 502, message: "provider trace customer@example.test" }, "provider"],
  ] as const;
  for (const [error, expected] of cases) {
    const result = describeGatewayFailure(error);
    assert.equal(result.cause, expected);
    assert.doesNotMatch(result.message, /raw-secret|private-model|private\.invalid|customer@example\.test/);
  }
});
