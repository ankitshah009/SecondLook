import test from "node:test";
import assert from "node:assert/strict";
import { validateScreenshot } from "../lib/screenshot-input";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
test("screenshot intake accepts a bounded supported image without fetching its URL", () => {
  const input = validateScreenshot({ image: "data:image/png;base64," + png.toString("base64"), url: "https://example.com/offer" });
  assert.equal(input.mediaType, "image/png");
  assert.deepEqual(input.data, png);
});
test("screenshot intake rejects disguised formats, oversized data, and credential-bearing URLs", () => {
  assert.throws(() => validateScreenshot({ image: "data:image/jpeg;base64," + png.toString("base64"), url: "https://example.com" }));
  assert.throws(() => validateScreenshot({ image: "data:image/png;base64," + Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64"), url: "https://example.com" }));
  assert.throws(() => validateScreenshot({ image: "data:image/png;base64," + png.toString("base64"), url: "https://secret@example.com" }));
});
