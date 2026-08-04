import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAttributionIndex,
  findAttributionForLine,
} from "../src/core/patch.js";

const firstCheckpoint = `diff --git a/app.txt b/app.txt
index 9f46047..5f5521f 100644
--- a/app.txt
+++ b/app.txt
@@ -1,2 +1,3 @@
 alpha
+owned by first
 bravo
`;

const shiftedCheckpoint = `diff --git a/app.txt b/app.txt
index 5f5521f..cc74f9e 100644
--- a/app.txt
+++ b/app.txt
@@ -1,3 +1,4 @@
+header from second
 alpha
 owned by first
 bravo
`;

const replacementCheckpoint = `diff --git a/app.txt b/app.txt
index cc74f9e..ca3f38a 100644
--- a/app.txt
+++ b/app.txt
@@ -1,4 +1,4 @@
 header from second
 alpha
-owned by first
+replacement from third
 bravo
`;

function checkpoint(id, patch, causedByEventId) {
  return {
    id,
    type: "file_edit_checkpoint",
    at: null,
    actor: "agent",
    summary: id,
    patch,
    causedByEventId,
  };
}

test("added-line attribution is rebased into deterministic final-tree coordinates", () => {
  const events = [
    {
      id: "prompt-1",
      type: "prompt",
      at: null,
      actor: "user",
      summary: "Add the owned line.",
      inputs: { prompt: "Add the owned line." },
    },
    {
      id: "action-1",
      type: "shell_command",
      at: null,
      actor: "agent",
      summary: "First edit",
      command: "edit app.txt",
    },
    checkpoint("checkpoint-1", firstCheckpoint, "action-1"),
    {
      id: "action-2",
      type: "shell_command",
      at: null,
      actor: "agent",
      summary: "Insert header",
      command: "edit app.txt",
    },
    checkpoint("checkpoint-2", shiftedCheckpoint, "action-2"),
  ];

  const attribution = buildAttributionIndex(events);
  const header = findAttributionForLine(attribution, "app.txt", 1);
  const shifted = findAttributionForLine(attribution, "app.txt", 3);

  assert.equal(header.eventId, "checkpoint-2");
  assert.equal(shifted.eventId, "checkpoint-1");
  assert.equal(shifted.coordinateSpace, "final_tree");
  assert.equal(shifted.attributionKind, "added_line");
  assert.equal(findAttributionForLine(attribution, "app.txt", 2), null);
  assert.deepEqual(
    attribution.get("app.txt").map(({ eventId, start, end }) => ({ eventId, start, end })),
    [
      { eventId: "checkpoint-2", start: 1, end: 1 },
      { eventId: "checkpoint-1", start: 3, end: 3 },
    ],
  );
  assert.deepEqual(buildAttributionIndex(events), attribution);
});

test("replacement removes stale ownership and attributes the final added line", () => {
  const events = [
    checkpoint("checkpoint-1", firstCheckpoint),
    checkpoint("checkpoint-2", shiftedCheckpoint),
    checkpoint("checkpoint-3", replacementCheckpoint),
  ];

  const attribution = buildAttributionIndex(events);
  assert.equal(findAttributionForLine(attribution, "app.txt", 3).eventId, "checkpoint-3");
  assert.equal(
    attribution.get("app.txt").some((range) => range.eventId === "checkpoint-1"),
    false,
  );
});

test("pure renames preserve surviving attribution and binary changes return none", () => {
  const rename = `diff --git a/app.txt b/src/app.txt
similarity index 100%
rename from app.txt
rename to src/app.txt
`;
  const binary = `diff --git a/src/app.txt b/src/app.txt
index ca3f38a..8a1218a 100644
Binary files a/src/app.txt and b/src/app.txt differ
`;

  const renamed = buildAttributionIndex([
    checkpoint("checkpoint-1", firstCheckpoint),
    checkpoint("checkpoint-2", rename),
  ]);
  assert.equal(findAttributionForLine(renamed, "src/app.txt", 2).eventId, "checkpoint-1");
  assert.equal(renamed.has("app.txt"), false);

  const binaryResult = buildAttributionIndex([
    checkpoint("checkpoint-1", firstCheckpoint),
    checkpoint("checkpoint-2", rename),
    checkpoint("checkpoint-3", binary),
  ]);
  assert.equal(binaryResult.has("src/app.txt"), false);
});
