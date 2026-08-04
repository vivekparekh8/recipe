import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rm, writeFile } from "node:fs/promises";

import {
  createTempRepo,
  commitFile,
  diff,
  run,
  runCli,
  runCliResult,
} from "./helpers.js";

test("verify audits bundle integrity, attachment consistency, and replay drift", async () => {
  const repoDir = await createTempRepo("recipe-verify-pass");
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
        { type: "file_edit_checkpoint", patch, summary: "Apply captured patch" },
        { type: "test_run", command: "node -e \"process.exit(0)\"", result: { exitCode: 0 } },
      ],
      outputs: {},
      privacy: {},
    }, null, 2)}\n`,
    "utf8",
  );

  await runCli(repoDir, ["capture", "--input", draftPath]);
  await runCli(repoDir, ["publish", "HEAD", "--json"]);

  const verifyResult = JSON.parse(
    await runCli(repoDir, ["verify", "HEAD", "--replay", "--json"]),
  );

  assert.equal(verifyResult.ok, true);
  assert.equal(verifyResult.failureCount, 0);
  assert.equal(verifyResult.attached, true);
  assert.equal(verifyResult.replay.status, "exact");

  const byId = new Map(verifyResult.checks.map((check) => [check.id, check]));
  assert.equal(byId.get("bundle.target_sha256").ok, true);
  assert.equal(byId.get("attachment.recipe_sha256").ok, true);
  assert.equal(byId.get("attachment.artifact_matches").ok, true);
  assert.equal(byId.get("replay.tests").ok, true);

  await rm(path.join(repoDir, ".git", "recipes", `${targetCommit}.json.zst`), { force: true });
  const verifyAfterStoreCleanup = JSON.parse(
    await runCli(repoDir, ["verify", "HEAD", "--json"]),
  );
  assert.equal(verifyAfterStoreCleanup.ok, true);
  const afterCleanupChecks = new Map(
    verifyAfterStoreCleanup.checks.map((check) => [check.id, check]),
  );
  assert.equal(afterCleanupChecks.get("attachment.artifact_matches").ok, true);
  assert.equal(afterCleanupChecks.get("attachment.bundle_path").level, "warning");
});

test("verify fails when attached recipe metadata is tampered", async () => {
  const repoDir = await createTempRepo("recipe-verify-fail");
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
      events: [{ type: "file_edit_checkpoint", patch }],
      outputs: {},
      privacy: {},
    }, null, 2)}\n`,
    "utf8",
  );

  await runCli(repoDir, ["capture", "--input", draftPath]);
  await runCli(repoDir, ["publish", "HEAD", "--json"]);

  const originalNote = await run(
    "git",
    ["notes", "--ref", "refs/notes/recipe", "show", "HEAD"],
    repoDir,
  );
  const tamperedNote = originalNote.replace(/Recipe-SHA256: .+/, "Recipe-SHA256: deadbeef");
  await run(
    "git",
    ["notes", "--ref", "refs/notes/recipe", "add", "-f", "-F", "-", "HEAD"],
    repoDir,
    { input: `${tamperedNote}\n` },
  );

  const verifyCommand = await runCliResult(repoDir, ["verify", "HEAD", "--json"]);
  assert.equal(verifyCommand.code, 1);
  const verifyResult = JSON.parse(verifyCommand.stdout);

  assert.equal(verifyResult.ok, false);
  assert.equal(verifyResult.failureCount > 0, true);

  const byId = new Map(verifyResult.checks.map((check) => [check.id, check]));
  assert.equal(byId.get("attachment.recipe_sha256").ok, false);
  assert.match(byId.get("attachment.recipe_sha256").actual, /deadbeef/);
});
