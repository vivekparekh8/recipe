import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { readRecipeBundle } from "../src/core/storage.js";
import { createTempRepo, commitFile, run, runCli } from "./helpers.js";

test("capture session flow records prompts, checkpoints, tests, and finalizes to a replayable bundle", async () => {
  const repoDir = await createTempRepo("recipe-session-cli");
  await commitFile(
    repoDir,
    "calc.js",
    "module.exports = { calc: () => 0 };\n",
    "base",
  );

  const start = JSON.parse(
    await runCli(repoDir, [
      "capture",
      "--start",
      "--source-agent",
      "codex",
      "--base",
      "HEAD",
      "--prompt",
      "Change calc to return 1.",
      "--json",
    ]),
  );

  assert.ok(start.sessionId);
  assert.equal(start.sourceAgent, "codex");

  const prompt = JSON.parse(
    await runCli(repoDir, [
      "capture",
      "--append-prompt",
      "Keep the edit minimal.",
      "--session",
      start.sessionId,
      "--json",
    ]),
  );

  assert.equal(prompt.event.type, "prompt");

  await writeFile(
    path.join(repoDir, "calc.js"),
    "module.exports = { calc: () => 1 };\n",
    "utf8",
  );

  const checkpoint = JSON.parse(
    await runCli(repoDir, [
      "capture",
      "--checkpoint",
      "--session",
      start.sessionId,
      "--summary",
      "Apply agent edits",
      "--json",
    ]),
  );

  assert.equal(checkpoint.appended, true);
  assert.deepEqual(checkpoint.files, ["calc.js"]);

  const recordedTest = JSON.parse(
    await runCli(repoDir, [
      "capture",
      "--record-test",
      "--session",
      start.sessionId,
      "--command",
      'node -e "const { calc } = require(\'./calc.js\'); process.exit(calc() === 1 ? 0 : 1)"',
      "--json",
    ]),
  );

  assert.equal(recordedTest.exitCode, 0);

  const transcript = JSON.parse(
    await runCli(repoDir, [
      "capture",
      "--session",
      start.sessionId,
      "--append-transcript",
      "user: Change calc to return 1.\nagent: applied one-line edit.",
      "--json",
    ]),
  );

  assert.ok(transcript.transcriptPath.endsWith("transcript.log"));

  await run("git", ["add", "calc.js"], repoDir);
  await run("git", ["commit", "-m", "target"], repoDir);
  const targetCommit = await run("git", ["rev-parse", "HEAD"], repoDir);

  const finalized = JSON.parse(
    await runCli(repoDir, [
      "capture",
      "--finalize",
      "--session",
      start.sessionId,
      "--target",
      "HEAD",
      "--json",
    ]),
  );

  assert.equal(finalized.targetCommit, targetCommit);
  assert.equal(finalized.recipe.repo.targetCommit, targetCommit);

  const storedRecipe = await readRecipeBundle("HEAD", { cwd: repoDir });
  assert.deepEqual(storedRecipe.instructions.prompts, [
    "Change calc to return 1.",
    "Keep the edit minimal.",
  ]);
  assert.deepEqual(
    storedRecipe.events.map((event) => event.type),
    ["prompt", "prompt", "file_edit_checkpoint", "test_run"],
  );
  assert.equal(storedRecipe.privacy.omittedBlobs.length, 1);
  assert.deepEqual(storedRecipe.privacy.omittedBlobs[0], {
    kind: "raw_transcript",
    storage: "local_only",
    published: false,
    reason: "not_required_for_replay",
  });
  assert.equal(JSON.stringify(storedRecipe).includes(transcript.transcriptPath), false);
  assert.equal(JSON.stringify(storedRecipe).includes(repoDir), false);
  assert.match(
    await readFile(transcript.transcriptPath, "utf8"),
    /agent: applied one-line edit/,
  );

  const replay = JSON.parse(
    await runCli(repoDir, [
      "replay",
      "HEAD",
      "--json",
    ]),
  );

  assert.equal(replay.status, "exact");
  assert.equal(replay.matchedTests, 1);
});
