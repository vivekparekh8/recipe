import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  validateIngestRecords,
  validateRecipe,
} from "../src/core/schema.js";
import { sha256Hex, stableStringify } from "../src/core/utils.js";
import { createTempRepo, commitFile, diff, runCli } from "./helpers.js";

function schemaFixture(name) {
  return new URL(`../fixtures/schema/0.1.0/${name}`, import.meta.url);
}

async function readFixture(name) {
  return JSON.parse(await readFile(schemaFixture(name), "utf8"));
}

test("schema command exports formal JSON Schemas and validate checks recipe bundles and ingest streams", async () => {
  const repoDir = await createTempRepo("recipe-schema");
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

  const recipeSchema = JSON.parse(await runCli(repoDir, ["schema", "recipe"]));
  assert.equal(recipeSchema.title, "recipe bundle");
  assert.equal(recipeSchema.properties.metadata.type, "object");

  const ingestSchema = JSON.parse(await runCli(repoDir, ["schema", "ingest-record"]));
  assert.equal(ingestSchema.title, "recipe ingest record");
  assert.equal(Array.isArray(ingestSchema.oneOf), true);

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

  const validateRecipeResult = JSON.parse(
    await runCli(repoDir, ["validate", "recipe", "HEAD", "--json"]),
  );
  assert.equal(validateRecipeResult.valid, true);

  const ingestPath = path.join(repoDir, "events.jsonl");
  await writeFile(
    ingestPath,
    `${JSON.stringify({ kind: "prompt", prompt: "Do the thing." })}\n${JSON.stringify({ kind: "shell", command: "echo ok" })}\n`,
    "utf8",
  );
  const validateIngestResult = JSON.parse(
    await runCli(repoDir, ["validate", "ingest", ingestPath, "--json"]),
  );
  assert.equal(validateIngestResult.valid, true);
  assert.equal(validateIngestResult.recordCount, 2);

  await assert.rejects(
    () => runCli(repoDir, ["validate", "ingest", "-"], {
      input: `${JSON.stringify({ kind: "tool" })}\n`,
    }),
    /toolName/,
  );
});

test("schema 0.1 compatibility fixtures freeze accepted and rejected contracts", async () => {
  const validRecipe = await readFixture("recipe.valid.json");
  assert.deepEqual(validateRecipe(validRecipe), []);

  const canonicalRecipe = structuredClone(validRecipe);
  canonicalRecipe.metadata.targetSha256 = null;
  assert.equal(
    sha256Hex(stableStringify(canonicalRecipe)),
    validRecipe.metadata.targetSha256,
  );
  assert.equal(stableStringify(validRecipe), stableStringify(structuredClone(validRecipe)));

  const invalidVersion = await readFixture("recipe.invalid-version.json");
  assert.match(validateRecipe(invalidVersion).join("\n"), /must equal 0\.1\.0/);

  const missingEvents = structuredClone(validRecipe);
  delete missingEvents.events;
  assert.match(validateRecipe(missingEvents).join("\n"), /events must be an array/);

  const incompatibleMetadata = structuredClone(validRecipe);
  incompatibleMetadata.metadata.requiredByFutureConsumer = true;
  assert.match(
    validateRecipe(incompatibleMetadata).join("\n"),
    /metadata\.requiredByFutureConsumer is not part of schema 0\.1\.0/,
  );

  const validIngest = await readFixture("ingest.valid.json");
  assert.deepEqual(validateIngestRecords(validIngest), []);

  const invalidIngest = await readFixture("ingest.invalid.json");
  const ingestErrors = validateIngestRecords(invalidIngest).join("\n");
  assert.match(ingestErrors, /toolName/);
  assert.match(ingestErrors, /future-record/);
});
