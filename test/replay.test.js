import test from "node:test";
import assert from "node:assert/strict";
import { access, rm } from "node:fs/promises";
import path from "node:path";

import { normalizeRecipe } from "../src/core/recipe.js";
import { replayRecipe } from "../src/core/replay.js";
import { writeRecipeBundle } from "../src/core/storage.js";
import {
  createTempRepo,
  commitFile,
  diff,
  run,
  runCliResult,
} from "./helpers.js";

test("replay sparsely checks out touched files when no tests were recorded", async () => {
  const repoDir = await createTempRepo("recipe-replay-sparse");
  await commitFile(repoDir, "unrelated.txt", "not needed for replay\n", "fixture");
  const baseCommit = await commitFile(repoDir, "calc.js", "export const value = 0;\n", "base");

  await run("git", ["checkout", "-b", "feature"], repoDir);
  const targetCommit = await commitFile(
    repoDir,
    "calc.js",
    "export const value = 1;\n",
    "target",
  );
  const patch = await diff(repoDir, baseCommit, targetCommit);
  const recipe = await normalizeRecipe(
    {
      metadata: { sourceAgent: "codex", adapterVersion: "0.1.0" },
      repo: { baseCommit, targetCommit },
      instructions: { prompts: ["Update value."] },
      events: [{ type: "file_edit_checkpoint", patch }],
      outputs: {},
      privacy: {},
    },
    { cwd: repoDir },
  );

  const result = await replayRecipe(recipe, { cwd: repoDir, keepWorktree: true });
  try {
    assert.equal(result.status, "exact");
    await access(path.join(result.worktreePath, "calc.js"));
    await assert.rejects(access(path.join(result.worktreePath, "unrelated.txt")));
  } finally {
    await run("git", ["worktree", "remove", "--force", result.worktreePath], repoDir);
    await rm(result.worktreePath, { recursive: true, force: true });
  }
});

test("replay keeps a full checkout when tests were recorded", async () => {
  const repoDir = await createTempRepo("recipe-replay-full");
  await commitFile(repoDir, "fixture.txt", "required by test\n", "fixture");
  const baseCommit = await commitFile(repoDir, "calc.js", "export const value = 0;\n", "base");

  await run("git", ["checkout", "-b", "feature"], repoDir);
  const targetCommit = await commitFile(
    repoDir,
    "calc.js",
    "export const value = 1;\n",
    "target",
  );
  const patch = await diff(repoDir, baseCommit, targetCommit);
  const recipe = await normalizeRecipe(
    {
      metadata: { sourceAgent: "codex", adapterVersion: "0.1.0" },
      repo: { baseCommit, targetCommit },
      instructions: { prompts: ["Update value."] },
      events: [
        { type: "file_edit_checkpoint", patch },
        {
          type: "test_run",
          command: "test -f fixture.txt",
          result: { exitCode: 0 },
        },
      ],
      outputs: {},
      privacy: {},
    },
    { cwd: repoDir },
  );

  const result = await replayRecipe(recipe, { cwd: repoDir, keepWorktree: true });
  try {
    assert.equal(result.status, "exact");
    assert.equal(result.success, true);
    await access(path.join(result.worktreePath, "fixture.txt"));
  } finally {
    await run("git", ["worktree", "remove", "--force", result.worktreePath], repoDir);
    await rm(result.worktreePath, { recursive: true, force: true });
  }
});

test("replay reproduces a captured patch and test sequence exactly", async () => {
  const repoDir = await createTempRepo("recipe-replay-exact");
  const baseCommit = await commitFile(
    repoDir,
    "calc.js",
    "module.exports = { calc: () => 0 };\n",
    "base",
  );

  await run("git", ["checkout", "-b", "feature"], repoDir);
  const targetCommit = await commitFile(
    repoDir,
    "calc.js",
    "module.exports = { calc: () => 1 };\n",
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
        prompts: ["Change calc to return 1."],
      },
      events: [
        {
          type: "test_run",
          command: 'node -e "const { calc } = require(\'./calc.js\'); process.exit(calc() === 0 ? 1 : 0)"',
          result: { exitCode: 1 },
        },
        {
          type: "file_edit_checkpoint",
          patch,
          summary: "Update calc implementation",
        },
        {
          type: "test_run",
          command: 'node -e "const { calc } = require(\'./calc.js\'); process.exit(calc() === 1 ? 0 : 1)"',
          result: { exitCode: 0 },
        },
      ],
      outputs: {},
      privacy: {},
    },
    { cwd: repoDir },
  );

  const result = await replayRecipe(recipe, { cwd: repoDir });

  assert.equal(result.status, "exact");
  assert.equal(result.success, true);
  assert.equal(result.appliedCheckpoints, 1);
  assert.equal(result.matchedTests, 2);
  assert.equal(result.diff, "");
});

test("replay reports drift when a captured patch no longer matches the target commit", async () => {
  const repoDir = await createTempRepo("recipe-replay-drift");
  const baseCommit = await commitFile(
    repoDir,
    "calc.js",
    "module.exports = { calc: () => 0 };\n",
    "base",
  );

  await run("git", ["checkout", "-b", "feature"], repoDir);
  const targetCommit = await commitFile(
    repoDir,
    "calc.js",
    "module.exports = { calc: () => 2 };\n",
    "target",
  );

  const mismatchedPatch = `diff --git a/calc.js b/calc.js
index 607b996..a3ac525 100644
--- a/calc.js
+++ b/calc.js
@@ -1 +1 @@
-module.exports = { calc: () => 0 };
+module.exports = { calc: () => 1 };
`;

  const recipe = await normalizeRecipe(
    {
      metadata: {
        sourceAgent: "claude-code",
        adapterVersion: "0.1.0",
      },
      repo: {
        baseCommit,
        targetCommit,
      },
      instructions: {
        prompts: ["Change calc to return 2."],
      },
      events: [
        {
          type: "file_edit_checkpoint",
          patch: mismatchedPatch,
        },
      ],
      outputs: {},
      privacy: {},
    },
    { cwd: repoDir },
  );

  const result = await replayRecipe(recipe, { cwd: repoDir });

  assert.equal(result.status, "mixed");
  assert.equal(result.success, false);
  assert.notEqual(result.diff, "");

  await writeRecipeBundle(recipe, { cwd: repoDir });
  for (const command of ["replay", "diff-replay"]) {
    const cliResult = await runCliResult(repoDir, [command, "HEAD"]);
    assert.equal(cliResult.code, 1, `${command} should fail on a non-exact tree`);
  }
});

test("replay reports drift when a checkpoint cannot be applied", async () => {
  const repoDir = await createTempRepo("recipe-replay-unappliable");
  const baseCommit = await commitFile(
    repoDir,
    "calc.js",
    "module.exports = { calc: () => 0 };\n",
    "base",
  );

  await run("git", ["checkout", "-b", "feature"], repoDir);
  const targetCommit = await commitFile(
    repoDir,
    "calc.js",
    "module.exports = { calc: () => 1 };\n",
    "target",
  );

  const recipe = await normalizeRecipe(
    {
      metadata: { sourceAgent: "codex", adapterVersion: "0.1.0" },
      repo: { baseCommit, targetCommit },
      instructions: { prompts: ["Change calc to return 1."] },
      events: [
        {
          id: "broken-checkpoint",
          type: "file_edit_checkpoint",
          patch: "not a unified diff\n",
        },
      ],
      outputs: {},
      privacy: {},
    },
    { cwd: repoDir },
  );

  const result = await replayRecipe(recipe, { cwd: repoDir });

  assert.equal(result.status, "drifted");
  assert.equal(result.success, false);
  assert.equal(result.failedCheckpoint, "broken-checkpoint");
  assert.ok(result.failedCheckpointError);
});

test("exact tree with a changed test outcome is unsuccessful for both replay commands", async () => {
  const repoDir = await createTempRepo("recipe-replay-test-drift");
  const baseCommit = await commitFile(
    repoDir,
    "calc.js",
    "module.exports = { calc: () => 0 };\n",
    "base",
  );

  await run("git", ["checkout", "-b", "feature"], repoDir);
  const targetCommit = await commitFile(
    repoDir,
    "calc.js",
    "module.exports = { calc: () => 1 };\n",
    "target",
  );
  const patch = await diff(repoDir, baseCommit, targetCommit);
  const recipe = await normalizeRecipe(
    {
      metadata: { sourceAgent: "codex", adapterVersion: "0.1.0" },
      repo: { baseCommit, targetCommit },
      instructions: { prompts: ["Change calc to return 1."] },
      events: [
        { type: "file_edit_checkpoint", patch },
        {
          type: "test_run",
          command: "node -e \"process.exit(0)\"",
          result: { exitCode: 1 },
        },
      ],
      outputs: {},
      privacy: {},
    },
    { cwd: repoDir },
  );

  const result = await replayRecipe(recipe, { cwd: repoDir });
  assert.equal(result.status, "exact");
  assert.equal(result.success, false);
  assert.equal(result.matchedTests, 0);
  assert.equal(result.totalTests, 1);

  await writeRecipeBundle(recipe, { cwd: repoDir });
  for (const command of ["replay", "diff-replay"]) {
    const cliResult = await runCliResult(repoDir, [command, "HEAD"]);
    assert.equal(cliResult.code, 1, `${command} should fail on test drift`);
  }

  const jsonResult = await runCliResult(repoDir, ["replay", "HEAD", "--json"]);
  assert.equal(jsonResult.code, 1);
  const output = JSON.parse(jsonResult.stdout);
  assert.equal(output.status, "exact");
  assert.equal(output.success, false);
});

test("replay applies both agent and human edit checkpoints for mixed authorship commits", async () => {
  const repoDir = await createTempRepo("recipe-replay-mixed-authorship");
  const baseCommit = await commitFile(
    repoDir,
    "calc.js",
    "module.exports = { calc: () => 0 };\n",
    "base",
  );

  await run("git", ["checkout", "-b", "feature"], repoDir);
  const aiCommit = await commitFile(
    repoDir,
    "calc.js",
    "module.exports = { calc: () => 1 };\n",
    "ai step",
  );
  const humanCommit = await commitFile(
    repoDir,
    "calc.js",
    "module.exports = { calc: () => 2 };\n",
    "human step",
  );

  const aiPatch = await diff(repoDir, baseCommit, aiCommit);
  const humanPatch = await diff(repoDir, aiCommit, humanCommit);

  const recipe = await normalizeRecipe(
    {
      metadata: {
        sourceAgent: "codex",
        adapterVersion: "0.1.0",
      },
      repo: {
        baseCommit,
        targetCommit: humanCommit,
      },
      instructions: {
        prompts: ["Change calc to return 1, then I may tune it."],
      },
      events: [
        {
          id: "prompt-1",
          type: "prompt",
          inputs: {
            prompt: "Change calc to return 1, then I may tune it.",
          },
        },
        {
          id: "shell-1",
          type: "shell_command",
          summary: "Apply agent edit",
          command: `node -e "require('fs').writeFileSync('calc.js', 'module.exports = { calc: () => 1 };\\n')"`,
          result: { exitCode: 0, stdout: "", stderr: "" },
        },
        {
          id: "agent-patch",
          type: "file_edit_checkpoint",
          summary: "Agent patch",
          causedByEventId: "shell-1",
          patch: aiPatch,
        },
        {
          id: "human-patch",
          type: "human_edit",
          summary: "Manual follow-up edit",
          patch: humanPatch,
        },
      ],
      outputs: {},
      privacy: {},
    },
    { cwd: repoDir },
  );

  const result = await replayRecipe(recipe, { cwd: repoDir });

  assert.equal(recipe.outputs.provenanceStatus, "ai_plus_human");
  assert.equal(result.status, "exact");
  assert.equal(result.success, true);
  assert.equal(result.appliedCheckpoints, 2);
  assert.equal(result.totalCheckpoints, 2);
  assert.equal(result.appliedAgentCheckpoints, 1);
  assert.equal(result.totalAgentCheckpoints, 1);
  assert.equal(result.appliedHumanEdits, 1);
  assert.equal(result.totalHumanEdits, 1);
  assert.equal(result.diff, "");
});
