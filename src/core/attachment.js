import path from "node:path";
import { realpath } from "node:fs/promises";

import { readGitNote, resolveRepoRoot, writeGitNote } from "./git.js";
import { buildTrailerBlock } from "./recipe.js";

export const DEFAULT_NOTES_REF = "refs/notes/recipe";

function repoRelative(filePath, repoRoot) {
  const relative = path.relative(repoRoot, filePath);
  return relative === "" ? "." : relative.replace(/\\/g, "/");
}

export function parseAttachmentNote(note) {
  const fields = {};

  for (const rawLine of note.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !line.includes(":")) {
      continue;
    }
    const separator = line.indexOf(":");
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    fields[key] = value;
  }

  return fields;
}

export function buildAttachmentNote(
  recipe,
  artifactPaths,
  {
    repoRoot,
    notesRef = DEFAULT_NOTES_REF,
    attachedAt = new Date().toISOString(),
  } = {},
) {
  const lines = [
    buildTrailerBlock(recipe),
    "",
    `Recipe-Notes-Ref: ${notesRef}`,
    `Recipe-Attached-At: ${attachedAt}`,
  ];

  if (artifactPaths.bundlePath) {
    lines.push(`Recipe-Bundle: ${repoRelative(artifactPaths.bundlePath, repoRoot)}`);
  }
  if (artifactPaths.summaryPath) {
    lines.push(`Recipe-Summary: ${repoRelative(artifactPaths.summaryPath, repoRoot)}`);
  }
  if (artifactPaths.trailerPath) {
    lines.push(`Recipe-Trailers: ${repoRelative(artifactPaths.trailerPath, repoRoot)}`);
  }
  if (artifactPaths.artifactPath) {
    lines.push(`Recipe-Artifact: ${repoRelative(artifactPaths.artifactPath, repoRoot)}`);
  }
  if (artifactPaths.commentPath) {
    lines.push(`Recipe-Comment: ${repoRelative(artifactPaths.commentPath, repoRoot)}`);
  }
  if (artifactPaths.manifestPath) {
    lines.push(`Recipe-Manifest: ${repoRelative(artifactPaths.manifestPath, repoRoot)}`);
  }
  if (artifactPaths.releaseTag) {
    lines.push(`Recipe-Release-Tag: ${artifactPaths.releaseTag}`);
  }
  if (artifactPaths.releaseUrl) {
    lines.push(`Recipe-Release-Url: ${artifactPaths.releaseUrl}`);
  }
  if (artifactPaths.artifactUrl) {
    lines.push(`Recipe-Artifact-Url: ${artifactPaths.artifactUrl}`);
  }
  if (artifactPaths.summaryUrl) {
    lines.push(`Recipe-Summary-Url: ${artifactPaths.summaryUrl}`);
  }
  if (artifactPaths.manifestUrl) {
    lines.push(`Recipe-Manifest-Url: ${artifactPaths.manifestUrl}`);
  }

  return lines.join("\n");
}

export async function attachRecipeToCommit(
  recipe,
  artifactPaths,
  {
    cwd,
    notesRef = DEFAULT_NOTES_REF,
  } = {},
) {
  const repoRoot = await realpath(await resolveRepoRoot(cwd));
  const canonicalArtifactPaths = { ...artifactPaths };
  for (const key of [
    "bundlePath",
    "summaryPath",
    "trailerPath",
    "artifactPath",
    "commentPath",
    "manifestPath",
  ]) {
    if (artifactPaths[key]) {
      canonicalArtifactPaths[key] = await realpath(artifactPaths[key]);
    }
  }
  const note = buildAttachmentNote(recipe, canonicalArtifactPaths, {
    repoRoot,
    notesRef,
  });
  await writeGitNote(notesRef, recipe.repo.targetCommit, `${note}\n`, { cwd });

  return {
    targetCommit: recipe.repo.targetCommit,
    notesRef,
    note,
  };
}

export async function readRecipeAttachment(
  targetCommit,
  {
    cwd,
    notesRef = DEFAULT_NOTES_REF,
  } = {},
) {
  const note = await readGitNote(notesRef, targetCommit, { cwd });
  if (!note) {
    return null;
  }

  return {
    notesRef,
    note,
    fields: parseAttachmentNote(note),
  };
}

export async function resolveAttachmentPaths(
  targetCommit,
  {
    cwd,
    notesRef = DEFAULT_NOTES_REF,
  } = {},
) {
  const attachment = await readRecipeAttachment(targetCommit, { cwd, notesRef });
  if (!attachment) {
    return null;
  }

  const repoRoot = await resolveRepoRoot(cwd);
  const resolveField = (key) => {
    const value = attachment.fields[key];
    return value ? path.resolve(repoRoot, ...value.split("/")) : null;
  };

  return {
    attachment,
    bundlePath: resolveField("Recipe-Bundle"),
    artifactPath: resolveField("Recipe-Artifact"),
    artifactUrl: attachment.fields["Recipe-Artifact-Url"] ?? null,
    commentPath: resolveField("Recipe-Comment"),
    manifestPath: resolveField("Recipe-Manifest"),
    manifestUrl: attachment.fields["Recipe-Manifest-Url"] ?? null,
    releaseTag: attachment.fields["Recipe-Release-Tag"] ?? null,
    releaseUrl: attachment.fields["Recipe-Release-Url"] ?? null,
    summaryPath: resolveField("Recipe-Summary"),
    summaryUrl: attachment.fields["Recipe-Summary-Url"] ?? null,
    trailerPath: resolveField("Recipe-Trailers"),
  };
}
