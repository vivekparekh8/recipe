import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { readRecipeBundle } from "../src/core/storage.js";
import { createTempRepo, commitFile, run, runCli } from "./helpers.js";

test("codex adapter records shell commands and auto-captures resulting checkpoints", async () => {
  const repoDir = await createTempRepo("recipe-codex-adapter");
  await commitFile(
    repoDir,
    "calc.js",
    "module.exports = { calc: () => 0 };\n",
    "base",
  );

  const started = JSON.parse(
    await runCli(repoDir, [
      "codex",
      "start",
      "--prompt",
      "Change calc to return 1.",
      "--json",
    ]),
  );

  const command = `node -e "require('fs').writeFileSync('calc.js', 'module.exports = { calc: () => 1 };\\n')"`;
  const stepped = JSON.parse(
    await runCli(repoDir, [
      "codex",
      "step",
      "--session",
      started.sessionId,
      "--prompt",
      "Apply the one-line fix.",
      "--command",
      command,
      "--summary",
      "Update calc implementation",
      "--json",
    ]),
  );

  assert.equal(stepped.shell.exitCode, 0);
  assert.equal(stepped.checkpoint.appended, true);
  assert.deepEqual(stepped.checkpoint.files, ["calc.js"]);
  assert.equal(stepped.events[1].type, "shell_command");
  assert.equal(stepped.checkpoint.event.causedByEventId, stepped.events[1].id);

  await run("git", ["add", "calc.js"], repoDir);
  await run("git", ["commit", "-m", "target"], repoDir);

  const finalized = JSON.parse(
    await runCli(repoDir, [
      "codex",
      "finalize",
      "--session",
      started.sessionId,
      "--target",
      "HEAD",
      "--json",
    ]),
  );

  const recipe = await readRecipeBundle("HEAD", { cwd: repoDir });
  assert.equal(finalized.recipe.metadata.sourceAgent, "codex");
  assert.equal(recipe.metadata.sourceAgent, "codex");
  assert.deepEqual(
    recipe.events.map((event) => event.type),
    ["prompt", "prompt", "shell_command", "file_edit_checkpoint"],
  );
  assert.equal(recipe.events[3].causedByEventId, recipe.events[2].id);

  const inspectLine = await runCli(repoDir, ["inspect", "HEAD", "--line", "calc.js:1"]);
  assert.match(inspectLine, /calc\.js:1/);
  assert.match(inspectLine, /caused by:\s+shell_command/);
  assert.match(inspectLine, /step:\s+Update calc implementation/);
  assert.match(inspectLine, /asked:\s+Apply the one-line fix\./);

  const replay = JSON.parse(
    await runCli(repoDir, ["replay", "HEAD", "--json"]),
  );
  assert.equal(replay.status, "exact");
});

test("claude adapter uses claude-code as the source-agent label", async () => {
  const repoDir = await createTempRepo("recipe-claude-adapter");
  await commitFile(
    repoDir,
    "notes.txt",
    "hello\n",
    "base",
  );

  const started = JSON.parse(
    await runCli(repoDir, [
      "claude",
      "start",
      "--prompt",
      "Update notes.",
      "--json",
    ]),
  );

  await writeFile(path.join(repoDir, "notes.txt"), "hello world\n", "utf8");

  await JSON.parse(
    await runCli(repoDir, [
      "claude",
      "checkpoint",
      "--session",
      started.sessionId,
      "--summary",
      "Capture Claude edits",
      "--json",
    ]),
  );

  await run("git", ["add", "notes.txt"], repoDir);
  await run("git", ["commit", "-m", "target"], repoDir);

  await JSON.parse(
    await runCli(repoDir, [
      "claude",
      "finalize",
      "--session",
      started.sessionId,
      "--target",
      "HEAD",
      "--json",
    ]),
  );

  const recipe = await readRecipeBundle("HEAD", { cwd: repoDir });
  assert.equal(recipe.metadata.sourceAgent, "claude-code");
});
