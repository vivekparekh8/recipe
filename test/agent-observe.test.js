import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { readCaptureSession } from "../src/core/session.js";
import { readRecipeBundle } from "../src/core/storage.js";
import { createTempRepo, commitFile, run, runCli } from "./helpers.js";

test("codex observe streams command output into the transcript and captures the resulting checkpoint", async () => {
  const repoDir = await createTempRepo("recipe-codex-observe");
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

  const observed = JSON.parse(
    await runCli(repoDir, [
      "codex",
      "observe",
      "--session",
      started.sessionId,
      "--prompt",
      "Change calc to return 1.",
      "--command",
      `node -e "console.log('agent says hi'); console.error('watch me'); require('fs').writeFileSync('calc.js', 'module.exports = { calc: () => 1 };\\n')"`,
      "--summary",
      "Observed live agent run",
      "--json",
    ]),
  );

  assert.equal(observed.shell.exitCode, 0);
  assert.match(observed.shell.stdout, /agent says hi/);
  assert.match(observed.shell.stderr, /watch me/);
  assert.equal(observed.checkpoint.appended, true);

  const session = await readCaptureSession(started.sessionId, { cwd: repoDir });
  const transcriptText = await readFile(session.privacy.rawTranscriptPath, "utf8");
  assert.match(transcriptText, /\$ node -e/);
  assert.match(transcriptText, /\[stdout\]/);
  assert.match(transcriptText, /agent says hi/);
  assert.match(transcriptText, /\[stderr\]/);
  assert.match(transcriptText, /watch me/);

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
    ["prompt", "shell_command", "file_edit_checkpoint"],
  );

  const replay = JSON.parse(
    await runCli(repoDir, ["replay", "HEAD", "--json"]),
  );
  assert.equal(replay.status, "exact");
});
