import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createTempRepo, commitFile, diff, runCli } from "./helpers.js";

test("publish emits a reviewer comment artifact and manifest with exact local commands", async () => {
  const repoDir = await createTempRepo("recipe-publish-review");
  const baseCommit = await commitFile(
    repoDir,
    "hello.js",
    "module.exports = { value: 1 };\n",
    "base",
  );
  const targetCommit = await commitFile(
    repoDir,
    "hello.js",
    "module.exports = { value: 2 };\n",
    "target",
  );
  const patch = await diff(repoDir, baseCommit, targetCommit);

  const draftPath = path.join(repoDir, "draft.json");
  await writeFile(
    draftPath,
    `${JSON.stringify({
      metadata: { sourceAgent: "codex", adapterVersion: "0.1.0" },
      repo: { baseCommit, targetCommit },
      instructions: { prompts: ["Update exported value."] },
      events: [
        {
          id: "evt-prompt",
          type: "prompt",
          actor: "user",
          summary: "Update exported value.",
          inputs: { prompt: "Update exported value." },
        },
        {
          id: "evt-shell",
          type: "shell_command",
          actor: "agent",
          summary: "Apply hello.js change",
          command: "codex apply hello change",
        },
        {
          id: "evt-checkpoint",
          type: "file_edit_checkpoint",
          actor: "agent",
          summary: "Capture hello.js change",
          patch,
          causedByEventId: "evt-shell",
        },
        {
          id: "evt-test",
          type: "test_run",
          actor: "agent",
          summary: "Replay sanity check",
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
    await runCli(repoDir, ["publish", "HEAD", "--verify", "--replay", "--json"]),
  );

  const comment = await readFile(published.commentPath, "utf8");
  assert.match(comment, /<!-- recipe-comment:/);
  assert.match(comment, /## recipe for/);
  assert.match(comment, /- verification: pass/);
  assert.match(comment, /- replay: exact \(1\/1 checkpoints, 1\/1 tests\)/);
  assert.match(comment, new RegExp(`recipe inspect ${targetCommit} --timeline`));
  assert.match(comment, new RegExp(`recipe verify ${targetCommit} --replay`));

  const manifest = JSON.parse(await readFile(published.manifestPath, "utf8"));
  assert.equal(manifest.targetCommit, targetCommit);
  assert.equal(manifest.commands.timeline, `recipe inspect ${targetCommit} --timeline`);
  assert.equal(manifest.commands.verify, `recipe verify ${targetCommit} --replay`);
  assert.equal(manifest.commands.githubSync, `recipe github sync-pr --pr <number> ${targetCommit}`);
  assert.equal(manifest.verification.ok, true);
  assert.equal(manifest.verification.replay.status, "exact");
});
