import test from "node:test";
import assert from "node:assert/strict";

import {
  PUBLIC_METADATA_TEXT_LIMIT_BYTES,
  REPLAY_CRITICAL_TEXT_WARNING_BYTES,
  utf8ByteLength,
} from "../src/core/limits.js";
import { sanitizeDraftPrivacy } from "../src/core/privacy.js";
import { normalizeRecipe } from "../src/core/recipe.js";
import { createTempRepo, commitFile, diff, run } from "./helpers.js";

test("normalizeRecipe redacts non-critical secrets and preserves replay-critical ones with findings", async () => {
  const repoDir = await createTempRepo("recipe-privacy");
  const baseCommit = await commitFile(
    repoDir,
    "config.js",
    "module.exports = { token: null };\n",
    "base",
  );

  await run("git", ["checkout", "-b", "feature"], repoDir);
  const targetCommit = await commitFile(
    repoDir,
    "config.js",
    "module.exports = { token: 'AKIA1234567890ABCDEF' };\n",
    "target",
  );

  const patch = await diff(repoDir, baseCommit, targetCommit);
  const recipe = await normalizeRecipe(
    {
      metadata: {
        sourceAgent: "codex",
        adapterVersion: "0.1.0",
      },
      repo: {
        baseCommit,
        targetCommit,
      },
      instructions: {
        prompts: [
          "Use token ghp_1234567890abcdefghijklmnopqrstuv for setup.",
        ],
      },
      events: [
        {
          type: "shell_command",
          command: "echo done",
          result: {
            exitCode: 0,
            stdout: "created sk-abcdefghijklmnop1234567890",
            stderr: "",
          },
        },
        {
          type: "file_edit_checkpoint",
          patch,
        },
      ],
      outputs: {},
      privacy: {},
    },
    { cwd: repoDir },
  );

  assert.match(
    recipe.instructions.prompts[0],
    /\[REDACTED:github_token\]/,
  );
  assert.match(
    recipe.events[0].result.stdout,
    /\[REDACTED:openai_api_key\]/,
  );
  assert.match(
    recipe.events[1].patch,
    /AKIA1234567890ABCDEF/,
  );

  assert.ok(
    recipe.privacy.redactions.some((entry) => entry.path === "instructions.prompts[0]"),
  );
  assert.ok(
    recipe.privacy.redactions.some((entry) => entry.path === "events[0].result.stdout"),
  );
  assert.ok(
    recipe.privacy.secretScanFindings.some(
      (entry) => entry.path === "events[1].patch" && entry.action === "preserved_replay_critical",
    ),
  );
});

test("public metadata truncation is bounded, unicode-safe, recorded, and deterministic", () => {
  const oversized = `begin:${"🙂".repeat(PUBLIC_METADATA_TEXT_LIMIT_BYTES)}:end`;
  const draft = {
    instructions: {
      prompts: [oversized],
      referencedArtifacts: [],
      promptRevisions: [{ prompt: oversized }],
    },
    events: [
      {
        type: "prompt",
        summary: oversized,
        inputs: { prompt: oversized },
      },
      {
        type: "tool_call",
        outputs: { text: oversized },
      },
      {
        type: "shell_command",
        command: oversized,
        result: { stdout: oversized },
      },
      {
        type: "test_run",
        command: oversized,
        result: { stdout: oversized },
      },
    ],
    outputs: { finalPatch: "replay-critical" },
    privacy: {},
  };

  const first = sanitizeDraftPrivacy(draft).draft;
  const second = sanitizeDraftPrivacy(draft).draft;
  assert.deepEqual(first, second);

  const boundedValues = [
    first.instructions.prompts[0],
    first.instructions.promptRevisions[0].prompt,
    first.events[0].summary,
    first.events[0].inputs.prompt,
    first.events[1].outputs.text,
    first.events[2].command,
    first.events[2].result.stdout,
    first.events[3].result.stdout,
  ];
  for (const value of boundedValues) {
    assert.ok(utf8ByteLength(value) <= PUBLIC_METADATA_TEXT_LIMIT_BYTES);
    assert.match(value, /\n\[TRUNCATED: \d+ bytes; limit \d+ bytes\]$/);
    assert.doesNotMatch(value, /\uFFFD/);
  }

  assert.equal(first.events[3].command, oversized);
  const truncations = first.privacy.redactions.filter(
    (entry) => entry.action === "truncated",
  );
  assert.equal(truncations.length, boundedValues.length);
  assert.deepEqual(
    truncations.map((entry) => entry.path),
    [
      "instructions.prompts[0]",
      "instructions.promptRevisions[0].prompt",
      "events[0].summary",
      "events[0].inputs.prompt",
      "events[1].outputs.text",
      "events[2].command",
      "events[2].result.stdout",
      "events[3].result.stdout",
    ],
  );
  for (const [index, truncation] of truncations.entries()) {
    assert.equal(truncation.originalBytes, utf8ByteLength(oversized));
    assert.equal(truncation.limitBytes, PUBLIC_METADATA_TEXT_LIMIT_BYTES);
    assert.equal(truncation.publishedBytes, utf8ByteLength(boundedValues[index]));
    assert.equal(truncation.unit, "utf8_bytes");
  }
});

test("oversize replay-critical patches are preserved and explicitly flagged", () => {
  const patch = `diff --git a/a b/a\n${"+x\n".repeat(
    Math.ceil(REPLAY_CRITICAL_TEXT_WARNING_BYTES / 3) + 1,
  )}`;
  const sanitized = sanitizeDraftPrivacy({
    instructions: {},
    events: [{ type: "file_edit_checkpoint", patch }],
    outputs: { finalPatch: patch },
    privacy: {},
  }).draft;

  assert.equal(sanitized.events[0].patch, patch);
  assert.equal(sanitized.outputs.finalPatch, patch);
  assert.deepEqual(
    sanitized.privacy.secretScanFindings
      .filter((entry) => entry.kind === "oversize_replay_critical")
      .map((entry) => entry.path),
    ["events[0].patch", "outputs.finalPatch"],
  );
  assert.equal(
    sanitized.privacy.redactions.some((entry) => entry.matcher === "size_limit"),
    false,
  );
});
