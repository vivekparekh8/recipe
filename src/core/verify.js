import { readFile } from "node:fs/promises";

import {
  DEFAULT_NOTES_REF,
  readRecipeAttachment,
  resolveAttachmentPaths,
} from "./attachment.js";
import { buildTrailerBlock } from "./recipe.js";
import { replayRecipe } from "./replay.js";
import {
  isRecipeBundleUrl,
  readRecipeBundle,
  readRecipeBundleFromFile,
  resolveRecipePath,
} from "./storage.js";
import { pathExists, sha256Hex, stableStringify } from "./utils.js";

function computeTargetSha256(recipe) {
  const candidate = {
    ...recipe,
    metadata: {
      ...recipe.metadata,
      targetSha256: null,
    },
  };
  return sha256Hex(stableStringify(candidate));
}

function sameRecipeIdentity(left, right) {
  return left.metadata.recipeId === right.metadata.recipeId
    && left.metadata.targetSha256 === right.metadata.targetSha256
    && left.repo.baseCommit === right.repo.baseCommit
    && left.repo.targetCommit === right.repo.targetCommit
    && left.outputs.provenanceStatus === right.outputs.provenanceStatus;
}

async function verifyRecipeArtifact(filePath, expectedRecipe) {
  const exists = await pathExists(filePath);
  if (!exists) {
    return {
      exists: false,
      readable: false,
      internalHashMatches: false,
      matchesExpectedRecipe: false,
      error: `Missing artifact at ${filePath}.`,
      recipe: null,
    };
  }

  let recipe;
  try {
    recipe = await readRecipeBundleFromFile(filePath);
  } catch (error) {
    return {
      exists: true,
      readable: false,
      internalHashMatches: false,
      matchesExpectedRecipe: false,
      error: error.message,
      recipe: null,
    };
  }

  const computedHash = computeTargetSha256(recipe);
  return {
    exists: true,
    readable: true,
    internalHashMatches: computedHash === recipe.metadata.targetSha256,
    matchesExpectedRecipe: sameRecipeIdentity(recipe, expectedRecipe),
    error: null,
    recipe,
  };
}

function summarizeReplayAudit(replayResult) {
  if (!replayResult) {
    return null;
  }

  return {
    status: replayResult.status,
    appliedCheckpoints: replayResult.appliedCheckpoints,
    totalCheckpoints: replayResult.totalCheckpoints,
    appliedAgentCheckpoints: replayResult.appliedAgentCheckpoints,
    totalAgentCheckpoints: replayResult.totalAgentCheckpoints,
    appliedHumanEdits: replayResult.appliedHumanEdits,
    totalHumanEdits: replayResult.totalHumanEdits,
    matchedTests: replayResult.matchedTests,
    totalTests: replayResult.totalTests,
    failedCheckpoint: replayResult.failedCheckpoint,
  };
}

export async function verifyRecipeRef(
  refOrPath,
  {
    cwd,
    notesRef = DEFAULT_NOTES_REF,
    replay = false,
  } = {},
) {
  const result = {
    ok: true,
    ref: refOrPath,
    bundlePath: null,
    recipeId: null,
    targetCommit: null,
    attached: false,
    checks: [],
    warningCount: 0,
    failureCount: 0,
    replay: null,
  };

  const pushCheck = ({
    id,
    ok,
    message,
    level = "error",
    ...details
  }) => {
    const check = {
      id,
      ok,
      level,
      message,
      ...details,
    };
    result.checks.push(check);
    if (!ok) {
      if (level === "warning") {
        result.warningCount += 1;
      } else {
        result.failureCount += 1;
        result.ok = false;
      }
    }
    return check;
  };

  const bundlePath = await resolveRecipePath(refOrPath, { cwd });
  result.bundlePath = bundlePath;

  if (!isRecipeBundleUrl(bundlePath) && !await pathExists(bundlePath)) {
    pushCheck({
      id: "bundle.path",
      ok: false,
      message: `Recipe bundle not found at ${bundlePath}.`,
      path: bundlePath,
    });
    return result;
  }

  pushCheck({
    id: "bundle.path",
    ok: true,
    message: isRecipeBundleUrl(bundlePath)
      ? `Resolved recipe bundle URL ${bundlePath}.`
      : `Resolved recipe bundle at ${bundlePath}.`,
    path: bundlePath,
  });

  let recipe;
  try {
    recipe = isRecipeBundleUrl(bundlePath)
      ? await readRecipeBundle(bundlePath, { cwd })
      : await readRecipeBundleFromFile(bundlePath);
  } catch (error) {
    pushCheck({
      id: "bundle.schema",
      ok: false,
      message: error.message,
    });
    return result;
  }

  result.recipeId = recipe.metadata.recipeId;
  result.targetCommit = recipe.repo.targetCommit;

  pushCheck({
    id: "bundle.schema",
    ok: true,
    message: "Recipe bundle conforms to the published schema.",
  });

  const computedTargetSha256 = computeTargetSha256(recipe);
  pushCheck({
    id: "bundle.target_sha256",
    ok: computedTargetSha256 === recipe.metadata.targetSha256,
    message: computedTargetSha256 === recipe.metadata.targetSha256
      ? "Bundle target SHA-256 matches the canonical recipe payload."
      : "Bundle target SHA-256 does not match the canonical recipe payload.",
    expected: recipe.metadata.targetSha256,
    actual: computedTargetSha256,
  });

  const attachment = recipe.repo.targetCommit
    ? await readRecipeAttachment(recipe.repo.targetCommit, { cwd, notesRef })
    : null;

  if (!attachment) {
    pushCheck({
      id: "attachment.present",
      ok: false,
      level: "warning",
      message: "No attached recipe note was found on the target commit.",
    });
  } else {
    result.attached = true;
    pushCheck({
      id: "attachment.present",
      ok: true,
      message: `Found attached recipe note in ${attachment.notesRef}.`,
      notesRef: attachment.notesRef,
    });

    const expectedFields = {
      "Recipe-Id": recipe.metadata.recipeId,
      "Recipe-Base": recipe.repo.baseCommit ?? "unknown",
      "Recipe-SHA256": recipe.metadata.targetSha256,
      "Recipe-Status": recipe.outputs.provenanceStatus,
      "Recipe-Notes-Ref": notesRef,
    };

    for (const [field, expected] of Object.entries(expectedFields)) {
      const actual = attachment.fields[field] ?? null;
      pushCheck({
        id: `attachment.${field.toLowerCase().replaceAll(/[^a-z0-9]+/g, "_")}`,
        ok: actual === expected,
        message: actual === expected
          ? `${field} matches the recipe bundle.`
          : `${field} does not match the recipe bundle.`,
        expected,
        actual,
      });
    }

    const attachmentPaths = await resolveAttachmentPaths(
      recipe.repo.targetCommit,
      { cwd, notesRef },
    );
    const bundleArtifactPath = attachmentPaths?.bundlePath ?? null;
    const publishedArtifactPath = attachmentPaths?.artifactPath ?? null;
    const publishedArtifactUrl = attachmentPaths?.artifactUrl ?? null;
    const commentPath = attachmentPaths?.commentPath ?? null;
    const manifestPath = attachmentPaths?.manifestPath ?? null;
    const manifestUrl = attachmentPaths?.manifestUrl ?? null;
    const releaseTag = attachmentPaths?.releaseTag ?? null;
    const releaseUrl = attachmentPaths?.releaseUrl ?? null;
    const trailerPath = attachmentPaths?.trailerPath ?? null;
    const summaryPath = attachmentPaths?.summaryPath ?? null;
    const summaryUrl = attachmentPaths?.summaryUrl ?? null;

    pushCheck({
      id: "attachment.bundle_field",
      ok: Boolean(bundleArtifactPath),
      level: "warning",
      message: bundleArtifactPath
        ? "Attachment note points at the canonical bundle."
        : "Attachment note is missing Recipe-Bundle.",
      path: bundleArtifactPath,
    });

    if (bundleArtifactPath) {
      const artifactCheck = await verifyRecipeArtifact(bundleArtifactPath, recipe);
      pushCheck({
        id: "attachment.bundle_path",
        ok: artifactCheck.exists,
        level: "warning",
        message: artifactCheck.exists
          ? `Attached bundle exists at ${bundleArtifactPath}.`
          : artifactCheck.error,
        path: bundleArtifactPath,
      });
      pushCheck({
        id: "attachment.bundle_readable",
        ok: artifactCheck.readable,
        level: "warning",
        message: artifactCheck.readable
          ? "Attached bundle is readable and valid JSON."
          : artifactCheck.error ?? "Attached bundle could not be read.",
        path: bundleArtifactPath,
      });
      if (artifactCheck.readable) {
        pushCheck({
          id: "attachment.bundle_integrity",
          ok: artifactCheck.internalHashMatches,
          message: artifactCheck.internalHashMatches
            ? "Attached bundle passes its own target SHA-256 integrity check."
            : "Attached bundle fails its own target SHA-256 integrity check.",
        });
        pushCheck({
          id: "attachment.bundle_matches",
          ok: artifactCheck.matchesExpectedRecipe,
          message: artifactCheck.matchesExpectedRecipe
            ? "Attached bundle matches the resolved recipe."
            : "Attached bundle does not match the resolved recipe.",
        });
      }
    }

    pushCheck({
      id: "attachment.artifact_field",
      ok: Boolean(publishedArtifactPath),
      message: publishedArtifactPath
        ? "Attachment note points at the published artifact copy."
        : "Attachment note is missing Recipe-Artifact.",
      path: publishedArtifactPath,
    });

    if (publishedArtifactPath) {
      const artifactCheck = await verifyRecipeArtifact(publishedArtifactPath, recipe);
      pushCheck({
        id: "attachment.artifact_path",
        ok: artifactCheck.exists,
        message: artifactCheck.exists
          ? `Published artifact exists at ${publishedArtifactPath}.`
          : artifactCheck.error,
        path: publishedArtifactPath,
      });
      pushCheck({
        id: "attachment.artifact_readable",
        ok: artifactCheck.readable,
        message: artifactCheck.readable
          ? "Published artifact is readable and valid JSON."
          : artifactCheck.error ?? "Published artifact could not be read.",
        path: publishedArtifactPath,
      });
      if (artifactCheck.readable) {
        pushCheck({
          id: "attachment.artifact_integrity",
          ok: artifactCheck.internalHashMatches,
          message: artifactCheck.internalHashMatches
            ? "Published artifact passes its own target SHA-256 integrity check."
            : "Published artifact fails its own target SHA-256 integrity check.",
        });
        pushCheck({
          id: "attachment.artifact_matches",
          ok: artifactCheck.matchesExpectedRecipe,
          message: artifactCheck.matchesExpectedRecipe
            ? "Published artifact matches the resolved recipe."
            : "Published artifact does not match the resolved recipe.",
        });
      }
    }

    pushCheck({
      id: "attachment.artifact_url",
      ok: Boolean(publishedArtifactUrl),
      level: "warning",
      message: publishedArtifactUrl
        ? "Attachment note points at a remote recipe artifact URL."
        : "Attachment note is missing Recipe-Artifact-Url.",
      url: publishedArtifactUrl,
    });

    pushCheck({
      id: "attachment.release_tag",
      ok: Boolean(releaseTag),
      level: "warning",
      message: releaseTag
        ? "Attachment note records the GitHub release tag."
        : "Attachment note is missing Recipe-Release-Tag.",
      tag: releaseTag,
    });

    pushCheck({
      id: "attachment.release_url",
      ok: Boolean(releaseUrl),
      level: "warning",
      message: releaseUrl
        ? "Attachment note points at the GitHub release page."
        : "Attachment note is missing Recipe-Release-Url.",
      url: releaseUrl,
    });

    pushCheck({
      id: "attachment.trailer_field",
      ok: Boolean(trailerPath),
      message: trailerPath
        ? "Attachment note points at the trailer artifact."
        : "Attachment note is missing Recipe-Trailers.",
      path: trailerPath,
    });

    if (trailerPath) {
      const trailerExists = await pathExists(trailerPath);
      pushCheck({
        id: "attachment.trailer_path",
        ok: trailerExists,
        message: trailerExists
          ? `Trailer artifact exists at ${trailerPath}.`
          : `Missing trailer artifact at ${trailerPath}.`,
        path: trailerPath,
      });
      if (trailerExists) {
        const trailerText = await readFile(trailerPath, "utf8");
        const expectedTrailers = buildTrailerBlock(recipe).trim();
        pushCheck({
          id: "attachment.trailer_matches",
          ok: trailerText.trim() === expectedTrailers,
          message: trailerText.trim() === expectedTrailers
            ? "Trailer artifact matches the recipe bundle."
            : "Trailer artifact does not match the recipe bundle.",
          expected: expectedTrailers,
          actual: trailerText.trim(),
        });
      }
    }

    pushCheck({
      id: "attachment.summary_field",
      ok: Boolean(summaryPath),
      level: "warning",
      message: summaryPath
        ? "Attachment note points at the markdown summary."
        : "Attachment note is missing Recipe-Summary.",
      path: summaryPath,
    });

    if (summaryPath) {
      const summaryExists = await pathExists(summaryPath);
      pushCheck({
        id: "attachment.summary_path",
        ok: summaryExists,
        level: "warning",
        message: summaryExists
          ? `Summary artifact exists at ${summaryPath}.`
          : `Missing summary artifact at ${summaryPath}.`,
        path: summaryPath,
      });
    }

    pushCheck({
      id: "attachment.summary_url",
      ok: Boolean(summaryUrl),
      level: "warning",
      message: summaryUrl
        ? "Attachment note points at the remote summary URL."
        : "Attachment note is missing Recipe-Summary-Url.",
      url: summaryUrl,
    });

    pushCheck({
      id: "attachment.comment_field",
      ok: Boolean(commentPath),
      level: "warning",
      message: commentPath
        ? "Attachment note points at the review comment artifact."
        : "Attachment note is missing Recipe-Comment.",
      path: commentPath,
    });

    if (commentPath) {
      const commentExists = await pathExists(commentPath);
      pushCheck({
        id: "attachment.comment_path",
        ok: commentExists,
        level: "warning",
        message: commentExists
          ? `Review comment artifact exists at ${commentPath}.`
          : `Missing review comment artifact at ${commentPath}.`,
        path: commentPath,
      });
    }

    pushCheck({
      id: "attachment.manifest_field",
      ok: Boolean(manifestPath),
      level: "warning",
      message: manifestPath
        ? "Attachment note points at the publish manifest."
        : "Attachment note is missing Recipe-Manifest.",
      path: manifestPath,
    });

    if (manifestPath) {
      const manifestExists = await pathExists(manifestPath);
      pushCheck({
        id: "attachment.manifest_path",
        ok: manifestExists,
        level: "warning",
        message: manifestExists
          ? `Publish manifest exists at ${manifestPath}.`
          : `Missing publish manifest at ${manifestPath}.`,
        path: manifestPath,
      });
    }

    pushCheck({
      id: "attachment.manifest_url",
      ok: Boolean(manifestUrl),
      level: "warning",
      message: manifestUrl
        ? "Attachment note points at the remote manifest URL."
        : "Attachment note is missing Recipe-Manifest-Url.",
      url: manifestUrl,
    });
  }

  if (replay) {
    const replayResult = await replayRecipe(recipe, { cwd });
    result.replay = summarizeReplayAudit(replayResult);
    pushCheck({
      id: "replay.checkpoints",
      ok: replayResult.appliedCheckpoints === replayResult.totalCheckpoints,
      message: replayResult.appliedCheckpoints === replayResult.totalCheckpoints
        ? "Replay applied every captured checkpoint."
        : "Replay did not apply every captured checkpoint.",
      expected: replayResult.totalCheckpoints,
      actual: replayResult.appliedCheckpoints,
      failedCheckpoint: replayResult.failedCheckpoint,
    });
    pushCheck({
      id: "replay.diff",
      ok: replayResult.status === "exact",
      message: replayResult.status === "exact"
        ? "Replay landed on the exact captured target."
        : `Replay ended with status "${replayResult.status}".`,
      actual: replayResult.status,
    });
    pushCheck({
      id: "replay.tests",
      ok: replayResult.matchedTests === replayResult.totalTests,
      message: replayResult.matchedTests === replayResult.totalTests
        ? "Replay reproduced every recorded test outcome."
        : "Replay drifted from at least one recorded test outcome.",
      expected: replayResult.totalTests,
      actual: replayResult.matchedTests,
    });
  }

  return result;
}
