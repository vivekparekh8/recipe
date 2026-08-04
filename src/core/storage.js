import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

import { DEFAULT_NOTES_REF, resolveAttachmentPaths } from "./attachment.js";
import { resolveCommit, resolveGitDir } from "./git.js";
import { assertValidRecipe } from "./schema.js";
import {
  ensureDir,
  pathExists,
  sha256Hex,
  stableStringify,
} from "./utils.js";

export function isRecipeBundleUrl(candidate) {
  return /^https?:\/\//i.test(candidate);
}

async function recipeStorePath(targetCommit, cwd) {
  const gitDir = await resolveGitDir(cwd);
  const storeDir = path.join(gitDir, "recipes");
  await ensureDir(storeDir);
  return path.join(storeDir, `${targetCommit}.json.zst`);
}

function encodeRecipe(recipe) {
  const canonicalJson = `${stableStringify(recipe)}\n`;
  return {
    sha256: sha256Hex(canonicalJson),
    compressed: zstdCompressSync(Buffer.from(canonicalJson, "utf8")),
  };
}

export async function writeRecipeBundle(recipe, { cwd } = {}) {
  assertValidRecipe(recipe);
  const outputPath = await recipeStorePath(recipe.repo.targetCommit, cwd);
  const encoded = encodeRecipe(recipe);
  await writeFile(outputPath, encoded.compressed);
  return {
    path: outputPath,
    sha256: encoded.sha256,
  };
}

export async function readRecipeBundleFromFile(filePath) {
  const compressed = await readRecipeBundleBytes(filePath);
  const recipe = decodeRecipeBuffer(compressed);
  assertValidRecipe(recipe);
  return recipe;
}

function decodeRecipeBuffer(buffer) {
  let json;
  try {
    json = zstdDecompressSync(buffer).toString("utf8");
  } catch {
    json = buffer.toString("utf8");
  }
  const recipe = JSON.parse(json);
  assertValidRecipe(recipe);
  return recipe;
}

export async function readRecipeBundleFromUrl(url) {
  const buffer = await readRecipeBundleBytes(url);
  return decodeRecipeBuffer(buffer);
}

export async function readRecipeBundleBytes(source) {
  if (isRecipeBundleUrl(source)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`Failed to fetch recipe bundle from ${source}: ${response.status} ${response.statusText}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }

  return readFile(source);
}

export async function resolveRecipePath(refOrPath, { cwd } = {}) {
  if (isRecipeBundleUrl(refOrPath)) {
    return refOrPath;
  }

  const absoluteCandidate = path.resolve(cwd, refOrPath);
  if (await pathExists(absoluteCandidate)) {
    return absoluteCandidate;
  }

  const targetCommit = await resolveCommit(refOrPath, { cwd });
  const storePath = await recipeStorePath(targetCommit, cwd);
  if (await pathExists(storePath)) {
    return storePath;
  }

  const attachmentPaths = await resolveAttachmentPaths(
    targetCommit,
    {
      cwd,
      notesRef: DEFAULT_NOTES_REF,
    },
  );
  if (attachmentPaths?.bundlePath && await pathExists(attachmentPaths.bundlePath)) {
    return attachmentPaths.bundlePath;
  }
  if (attachmentPaths?.artifactPath && await pathExists(attachmentPaths.artifactPath)) {
    return attachmentPaths.artifactPath;
  }
  if (attachmentPaths?.artifactUrl) {
    return attachmentPaths.artifactUrl;
  }

  return storePath;
}

export async function readRecipeBundle(refOrPath, { cwd } = {}) {
  const filePath = await resolveRecipePath(refOrPath, { cwd });
  if (isRecipeBundleUrl(filePath)) {
    return readRecipeBundleFromUrl(filePath);
  }
  return readRecipeBundleFromFile(filePath);
}
