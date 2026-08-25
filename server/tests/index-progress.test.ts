import assert from "node:assert/strict";
import test from "node:test";

import { serializeMediaIndexProgress } from "../src/index.ts";

test("serializeMediaIndexProgress reports progress as scanned files over total", () => {
  const payload = serializeMediaIndexProgress({
    status: "indexing",
    scannedFiles: 40,
    totalFiles: 100,
    indexedFiles: 35,
    startedAtMs: 1,
    updatedAtMs: 2,
  });

  assert.equal(payload.status, "indexing");
  assert.equal(payload.current, 40);
  assert.equal(payload.total, 100);
  assert.equal(payload.percent, 40);
  assert.equal(payload.indexedFiles, 35);
});
