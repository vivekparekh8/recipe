import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createTempRepo, commitFile, diff, runCli } from "./helpers.js";

test("inspect --timeline and publish summary render a step-by-step provenance story", async () => {
  const repoDir = await createTempRepo("recipe-timeline");
  const baseCommit = await commitFile(
    repoDir,
    "calc.js",
    "module.exports = { calc: () => 0 };\n",
    "base",
  );
  const targetCommit = await commitFile(
    repoDir,
    "calc.js",
    "module.exports = { calc: () => 1 };\n",
    "target",
  );
  const patch = await diff(repoDir, baseCommit, targetCommit);

  const draftPath = path.join(repoDir, "draft.json");
  await writeFile(
    draftPath,
    `${JSON.stringify({
      metadata: { sourceAgent: "codex", adapterVersion: "0.1.0" },
      repo: { baseCommit, targetCommit },
      instructions: { prompts: ["Change calc to return 1."] },
      events: [
        {
          id: "evt-prompt",
          type: "prompt",
          actor: "user",
          summary: "Change calc to return 1.",
          inputs: { prompt: "Change calc to return 1." },
        },
        {
          id: "evt-shell",
          type: "shell_command",
          actor: "agent",
          summary: "Apply calc fix",
          command: "codex apply calc fix",
        },
        {
          id: "evt-checkpoint",
          type: "file_edit_checkpoint",
          actor: "agent",
          summary: "Capture calc update",
          patch,
          causedByEventId: "evt-shell",
        },
        {
          id: "evt-test",
          type: "test_run",
          actor: "agent",
          summary: "Verify calc now returns 1",
          command: "node -e \"process.exit(0)\"",
          result: { exitCode: 0 },
        },
      ],
      outputs: {},
      privacy: {},
    }, null, 2)}\n`,
    "utf8",
  );

  await runCli(repoDir, ["capture", "--input", draftPath]);
  const published = JSON.parse(
    await runCli(repoDir, ["publish", "HEAD", "--json"]),
  );

  const timeline = await runCli(repoDir, ["inspect", "HEAD", "--timeline"]);
  assert.match(timeline, /Timeline:/);
  assert.match(timeline, /1\. shell_command \(evt-shell\) :: Apply calc fix/);
  assert.match(timeline, /prompt: Change calc to return 1\./);
  assert.match(timeline, /files:\s+calc\.js/);
  assert.match(timeline, /checkpoint: file_edit_checkpoint \(evt-checkpoint\) :: Capture calc update \[calc\.js\]/);
  assert.match(timeline, /test: Verify calc now returns 1 -> exit 0/);

  const summary = await readFile(published.summaryPath, "utf8");
  assert.match(summary, /## Timeline/);
  assert.match(summary, /### Step 1/);
  assert.match(summary, /- prompt: Change calc to return 1\./);
  assert.match(summary, /- action: shell_command \(evt-shell\) :: Apply calc fix/);
  assert.match(summary, /- checkpoint: file_edit_checkpoint \(evt-checkpoint\) :: Capture calc update \[calc\.js\]/);
  assert.match(summary, /- test: Verify calc now returns 1 -> exit 0/);
});
