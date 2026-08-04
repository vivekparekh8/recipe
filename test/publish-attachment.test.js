import test from "node:test";
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";

import { readRecipeBundle } from "../src/core/storage.js";
import { createTempRepo, commitFile, diff, run, runCli } from "./helpers.js";

test("publish attaches recipe metadata to the commit via git notes and inspect surfaces it", async () => {
  const repoDir = await createTempRepo("recipe-publish-attach");
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

  const draftPath = `${repoDir}/draft.json`;
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
  const published = JSON.parse(
    await runCli(repoDir, ["publish", "HEAD", "--json"]),
  );

  assert.equal(published.targetCommit, targetCommit);
  assert.equal(published.attachment.notesRef, "refs/notes/recipe");

  const note = await run(
    "git",
    ["notes", "--ref", "refs/notes/recipe", "show", "HEAD"],
    repoDir,
  );
  assert.match(note, /Recipe-Id:/);
  assert.match(note, /Recipe-SHA256:/);
  assert.match(note, /Recipe-Bundle: \.git\/recipes\//);
  assert.match(note, /Recipe-Summary: outputs\//);
  assert.match(note, /Recipe-Comment: outputs\//);
  assert.match(note, /Recipe-Manifest: outputs\//);

  const inspect = await runCli(repoDir, ["inspect", "HEAD"]);
  assert.match(inspect, /attached: yes/);
  assert.match(inspect, /Attachment note \(refs\/notes\/recipe\):/);

  const recipe = await readRecipeBundle("HEAD", { cwd: repoDir });
  assert.equal(recipe.repo.targetCommit, targetCommit);

  await rm(`${repoDir}/.git/recipes/${targetCommit}.json.zst`, { force: true });

  const resolvedAfterStoreRemoval = await readRecipeBundle("HEAD", { cwd: repoDir });
  assert.equal(resolvedAfterStoreRemoval.repo.targetCommit, targetCommit);

  const inspectAfterStoreRemoval = await runCli(repoDir, ["inspect", "HEAD"]);
  assert.match(inspectAfterStoreRemoval, /attached: yes/);

  const replayAfterStoreRemoval = JSON.parse(
    await runCli(repoDir, ["replay", "HEAD", "--json"]),
  );
  assert.equal(replayAfterStoreRemoval.status, "exact");
});
