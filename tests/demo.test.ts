import { test } from "node:test";
import assert from "node:assert/strict";
import { isDemo } from "../src/lib/demo";
import { startSendingJob, startEnrichmentJob, startDraftingJob } from "../src/lib/jobs";

test("demo mode blocks every job that reaches outside the app", () => {
  process.env.DEMO_MODE = "1";
  assert.equal(isDemo(), true);
  assert.equal(startEnrichmentJob(1), false);
  assert.equal(startDraftingJob(1), false);
  assert.match(String(startSendingJob(1)), /switched off/);
  delete process.env.DEMO_MODE;
  assert.equal(isDemo(), false);
});
