import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { readRecipeBundle } from "../src/core/storage.js";
import { createTempRepo, commitFile, run, runCli } from "./helpers.js";

test("codex ingest imports streamed JSONL records into a replayable session", async () => {
  const repoDir = await createTempRepo("recipe-codex-ingest");
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
      "--json",
    ]),
  );

  await writeFile(
    path.join(repoDir, "calc.js"),
    "module.exports = { calc: () => 1 };\n",
    "utf8",
  );

  const importedCommand = `node -e "const { calc } = require('./calc.js'); process.exit(calc() === 1 ? 0 : 1)"`;
  const records = [
    {
      kind: "prompt",
      actor: "user",
      prompt: "Change calc to return 1.",
    },
    {
      kind: "shell",
      actor: "agent",
      summary: "Imported shell step",
      command: "codex apply calc fix",
      result: {
        exitCode: 0,
        stdout: "updated calc.js",
        stderr: "",
      },
      checkpoint: true,
    },
    {
      kind: "transcript",
      text: "assistant: updated calc.js",
    },
    {
      kind: "test",
      actor: "agent",
      summary: "Imported test result",
      command: importedCommand,
      result: {
        exitCode: 0,
        stdout: "",
        stderr: "",
      },
    },
  ];
  const eventLog = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

  const ingested = JSON.parse(
    await runCli(repoDir, [
      "codex",
      "ingest",
      "--session",
      started.sessionId,
      "--stdin",
      "--json",
    ], {
      input: eventLog,
    }),
  );

  assert.equal(ingested.processedCount, 4);
  assert.equal(ingested.processed[1].event.type, "shell_command");
  assert.equal(ingested.processed[1].checkpoint.appended, true);
  assert.equal(
    ingested.processed[1].checkpoint.event.causedByEventId,
    ingested.processed[1].event.id,
  );

  await run("git", ["add", "calc.js"], repoDir);
  await run("git", ["commit", "-m", "target"], repoDir);

  await JSON.parse(
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
  assert.deepEqual(
    recipe.events.map((event) => event.type),
    ["prompt", "shell_command", "file_edit_checkpoint", "test_run"],
  );

  const inspectLine = await runCli(repoDir, ["inspect", "HEAD", "--line", "calc.js:1"]);
  assert.match(inspectLine, /caused by:\s+shell_command/);
  assert.match(inspectLine, /step:\s+Imported shell step/);
  assert.match(inspectLine, /asked:\s+Change calc to return 1\./);

  const replay = JSON.parse(
    await runCli(repoDir, ["replay", "HEAD", "--json"]),
  );
  assert.equal(replay.status, "exact");
  assert.equal(replay.matchedTests, 1);
});
