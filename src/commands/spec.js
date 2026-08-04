import { readFile } from "node:fs/promises";

import {
  getIngestRecordJsonSchema,
  getIngestStreamJsonSchema,
  getRecipeJsonSchema,
  validateIngestRecords,
  validateRecipe,
} from "../core/schema.js";
import { readRecipeBundle } from "../core/storage.js";
import { parseJsonLines } from "../core/utils.js";

async function readStdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readTextInput(target) {
  if (target === "-") {
    return readStdinText();
  }
  return readFile(target, "utf8");
}

function resolveSchemaTarget(kind) {
  if (kind === "recipe") {
    return getRecipeJsonSchema();
  }
  if (kind === "ingest-record") {
    return getIngestRecordJsonSchema();
  }
  if (kind === "ingest-stream") {
    return getIngestStreamJsonSchema();
  }
  throw new Error(`Unknown schema target "${kind}".`);
}

async function parseIngestInput(target) {
  const text = await readTextInput(target);
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }
  return parseJsonLines(text);
}

export async function runSchemaCommand({ positionals }) {
  const target = positionals[0] ?? "recipe";
  console.log(JSON.stringify(resolveSchemaTarget(target), null, 2));
}

export async function runValidateCommand({ positionals, options }) {
  const mode = positionals[0] ?? "recipe";
  const target = positionals[1] ?? options.input ?? "HEAD";
  const cwd = options.cwd ?? process.cwd();

  if (mode === "recipe") {
    const recipe = await readRecipeBundle(target, { cwd });
    const errors = validateRecipe(recipe);
    const result = {
      valid: errors.length === 0,
      mode,
      target,
      errorCount: errors.length,
      errors,
    };
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.valid) {
      console.log(`Recipe is valid: ${target}`);
      return;
    }
    throw new Error(`Recipe validation failed:\n- ${errors.join("\n- ")}`);
  }

  if (mode === "ingest") {
    const records = await parseIngestInput(target);
    const errors = validateIngestRecords(records);
    const result = {
      valid: errors.length === 0,
      mode,
      target,
      recordCount: records.length,
      errorCount: errors.length,
      errors,
    };
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.valid) {
      console.log(`Ingest stream is valid: ${target} (${records.length} records)`);
      return;
    }
    throw new Error(`Ingest validation failed:\n- ${errors.join("\n- ")}`);
  }

  throw new Error(`Unknown validate mode "${mode}".`);
}
