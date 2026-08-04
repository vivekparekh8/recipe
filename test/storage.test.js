import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { attachRecipeToCommit } from "../src/core/attachment.js";
import { replayRecipe } from "../src/core/replay.js";
import { normalizeRecipe } from "../src/core/recipe.js";
import { readRecipeBundle, writeRecipeBundle } from "../src/core/storage.js";
import { createTempRepo, commitFile, diff } from "./helpers.js";

test("capture stores a compressed recipe bundle under .git/recipes", async () => {
  const repoDir = await createTempRepo("recipe-storage");
  const baseCommit = await commitFile(
    repoDir,
    "hello.js",
    "export const value = 1;\n",
    "base",
  );
  const targetCommit = await commitFile(
    repoDir,
    "hello.js",
    "export const value = 2;\n",
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
        prompts: ["Update the exported value to 2."],
      },
      events: [
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

  const stored = await writeRecipeBundle(recipe, { cwd: repoDir });
  const loaded = await readRecipeBundle(targetCommit, { cwd: repoDir });

  assert.equal(
    path.basename(stored.path),
    `${targetCommit}.json.zst`,
  );
  assert.equal(loaded.repo.targetCommit, targetCommit);
  assert.deepEqual(loaded.outputs.touchedFiles, ["hello.js"]);
  assert.equal(loaded.outputs.provenanceStatus, "pure_ai");
  assert.ok(loaded.metadata.targetSha256);
});

test("recipe bundles can be loaded and replayed from a remote URL or an attached remote fallback", async () => {
  const repoDir = await createTempRepo("recipe-storage-remote");
  const baseCommit = await commitFile(
    repoDir,
    "hello.js",
    "export const value = 1;\n",
    "base",
  );
  const targetCommit = await commitFile(
    repoDir,
    "hello.js",
    "export const value = 2;\n",
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
        prompts: ["Update the exported value to 2."],
      },
      events: [
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

  const stored = await writeRecipeBundle(recipe, { cwd: repoDir });
  const compressed = await readFile(stored.path);

  const url = "https://example.test/recipe.json.zst";
  const originalFetch = global.fetch;
  global.fetch = async (input) => {
    if (String(input) !== url) {
      return new Response("missing", { status: 404 });
    }
    return new Response(compressed, {
      status: 200,
      headers: {
        "content-type": "application/zstd",
      },
    });
  };

  try {
    const loadedFromUrl = await readRecipeBundle(url, { cwd: repoDir });
    assert.equal(loadedFromUrl.repo.targetCommit, targetCommit);

    const replayFromUrl = await replayRecipe(loadedFromUrl, { cwd: repoDir });
    assert.equal(replayFromUrl.status, "exact");

    await attachRecipeToCommit(
      recipe,
      {
        bundlePath: stored.path,
        artifactUrl: url,
      },
      { cwd: repoDir },
    );

    await rm(stored.path, { force: true });

    const loadedFromAttachedUrl = await readRecipeBundle(targetCommit, { cwd: repoDir });
    assert.equal(loadedFromAttachedUrl.repo.targetCommit, targetCommit);
  } finally {
    global.fetch = originalFetch;
  }
});
