import { copyFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { attachRecipeToCommit, DEFAULT_NOTES_REF } from "./attachment.js";
import { addGitHubCommentMarker } from "./github.js";
import {
  buildGitHubReleaseAssetIndex,
  ensureGitHubRelease,
  uploadGitHubReleaseAssets,
} from "./github.js";
import {
  buildMarkdownSummary,
  buildPublishManifest,
  buildReviewComment,
  buildTrailerBlock,
} from "./recipe.js";
import {
  isRecipeBundleUrl,
  readRecipeBundle,
  readRecipeBundleBytes,
  resolveRecipePath,
} from "./storage.js";
import { verifyRecipeRef } from "./verify.js";
import { ensureDir, writeJsonFile, writeTextFile } from "./utils.js";

function buildArtifactPaths(targetCommit, outputDir) {
  const shortCommit = targetCommit.slice(0, 12);
  return {
    summaryPath: path.join(outputDir, `${shortCommit}.recipe.md`),
    trailerPath: path.join(outputDir, `${shortCommit}.trailers.txt`),
    artifactPath: path.join(outputDir, `${shortCommit}.recipe.json.zst`),
    commentPath: path.join(outputDir, `${shortCommit}.recipe-comment.md`),
    manifestPath: path.join(outputDir, `${shortCommit}.recipe-publish.json`),
  };
}

function buildRecipeCommentMetadata(remoteArtifacts, artifactPaths) {
  if (!remoteArtifacts) {
    return null;
  }

  return {
    releaseTag: remoteArtifacts.releaseTag ?? null,
    releaseUrl: remoteArtifacts.releaseUrl ?? null,
    artifactUrl: remoteArtifacts.artifactUrl ?? null,
    manifestUrl: remoteArtifacts.manifestUrl ?? null,
    summaryUrl: remoteArtifacts.summaryUrl ?? null,
    artifactName: path.basename(artifactPaths.artifactPath),
    manifestName: path.basename(artifactPaths.manifestPath),
    summaryName: path.basename(artifactPaths.summaryPath),
  };
}

async function writePublishArtifacts(
  recipe,
  bundlePath,
  artifactPaths,
  {
    verification = null,
    remoteArtifacts = null,
  } = {},
) {
  await writeTextFile(artifactPaths.summaryPath, buildMarkdownSummary(recipe));
  await writeTextFile(artifactPaths.trailerPath, buildTrailerBlock(recipe));
  if (isRecipeBundleUrl(bundlePath)) {
    const bundleBytes = await readRecipeBundleBytes(bundlePath);
    await writeFile(artifactPaths.artifactPath, bundleBytes);
  } else {
    await copyFile(bundlePath, artifactPaths.artifactPath);
  }
  await writeTextFile(
    artifactPaths.commentPath,
    addGitHubCommentMarker(
      buildReviewComment(recipe, { verification, remoteArtifacts }),
      {
        recipeId: recipe.metadata.recipeId,
        targetCommit: recipe.repo.targetCommit,
        metadata: buildRecipeCommentMetadata(remoteArtifacts, artifactPaths),
      },
    ),
  );
  await writeJsonFile(
    artifactPaths.manifestPath,
    buildPublishManifest(
      recipe,
      {
        bundlePath,
        ...artifactPaths,
      },
      {
        verification,
        remoteArtifacts,
      },
    ),
  );
}

function assetUrlByName(release, filePath) {
  const index = buildGitHubReleaseAssetIndex(release);
  return index.get(path.basename(filePath))?.browser_download_url ?? null;
}

async function uploadRecipeReleaseArtifacts(
  recipe,
  artifactPaths,
  {
    cwd,
    tag,
    title,
    notes,
  },
) {
  const ensured = await ensureGitHubRelease(
    {
      tag,
      title,
      notes,
      targetCommit: recipe.repo.targetCommit,
    },
    { cwd },
  );

  const firstUpload = await uploadGitHubReleaseAssets(
    {
      tag,
      filePaths: [
        artifactPaths.artifactPath,
        artifactPaths.summaryPath,
        artifactPaths.trailerPath,
      ],
    },
    { cwd },
  );

  let remoteArtifacts = {
    releaseTag: tag,
    releaseUrl: firstUpload.release.html_url ?? ensured.release.html_url ?? null,
    artifactUrl: assetUrlByName(firstUpload.release, artifactPaths.artifactPath),
    summaryUrl: assetUrlByName(firstUpload.release, artifactPaths.summaryPath),
    manifestUrl: null,
  };

  await writeTextFile(
    artifactPaths.commentPath,
    addGitHubCommentMarker(
      buildReviewComment(recipe, { remoteArtifacts }),
      {
        recipeId: recipe.metadata.recipeId,
        targetCommit: recipe.repo.targetCommit,
        metadata: buildRecipeCommentMetadata(remoteArtifacts, artifactPaths),
      },
    ),
  );

  await writeJsonFile(
    artifactPaths.manifestPath,
    buildPublishManifest(
      recipe,
      artifactPaths,
      {
        remoteArtifacts,
      },
    ),
  );

  const secondUpload = await uploadGitHubReleaseAssets(
    {
      tag,
      filePaths: [
        artifactPaths.manifestPath,
      ],
    },
    { cwd },
  );

  remoteArtifacts = {
    ...remoteArtifacts,
    manifestUrl: assetUrlByName(secondUpload.release, artifactPaths.manifestPath),
  };

  return remoteArtifacts;
}

export async function publishRecipe(
  recipe,
  {
    cwd,
    bundlePath,
    outputDir = path.resolve(cwd, "outputs"),
    attach = true,
    notesRef = DEFAULT_NOTES_REF,
    verify = false,
    replay = false,
    releaseTag = null,
  } = {},
) {
  await ensureDir(outputDir);
  const artifactPaths = buildArtifactPaths(recipe.repo.targetCommit, outputDir);
  const noteBundlePath = isRecipeBundleUrl(bundlePath) ? null : bundlePath;

  await writePublishArtifacts(recipe, bundlePath, artifactPaths);

  let attachment = null;
  if (attach) {
    attachment = await attachRecipeToCommit(
      recipe,
      {
        bundlePath: noteBundlePath,
        ...artifactPaths,
      },
      {
        cwd,
        notesRef,
      },
    );
  }

  let verification = null;
  if (verify) {
    verification = await verifyRecipeRef(recipe.repo.targetCommit, {
      cwd,
      notesRef,
      replay,
    });
    await writePublishArtifacts(recipe, bundlePath, artifactPaths, { verification });
  }

  let remoteArtifacts = null;
  if (releaseTag) {
    remoteArtifacts = await uploadRecipeReleaseArtifacts(
      recipe,
      artifactPaths,
      {
        cwd,
        tag: releaseTag,
        title: "recipe artifacts",
        notes: "Replayable recipe bundles for AI-assisted commits.",
      },
    );
    await writePublishArtifacts(
      recipe,
      bundlePath,
      artifactPaths,
      {
        verification,
        remoteArtifacts,
      },
    );
    await uploadGitHubReleaseAssets(
      {
        tag: releaseTag,
        filePaths: [
          artifactPaths.manifestPath,
        ],
      },
      { cwd },
    );
    if (attach) {
      attachment = await attachRecipeToCommit(
        recipe,
        {
          bundlePath: noteBundlePath,
          ...artifactPaths,
          ...remoteArtifacts,
        },
        {
          cwd,
          notesRef,
        },
      );
    }
  }

  return {
    targetCommit: recipe.repo.targetCommit,
    bundlePath,
    ...artifactPaths,
    attachment,
    verification,
    remoteArtifacts,
  };
}

export async function publishRecipeRef(
  refOrPath,
  {
    cwd,
    outputDir = path.resolve(cwd, "outputs"),
    attach = true,
    notesRef = DEFAULT_NOTES_REF,
    verify = false,
    replay = false,
    releaseTag = null,
  } = {},
) {
  const recipe = await readRecipeBundle(refOrPath, { cwd });
  const bundlePath = await resolveRecipePath(refOrPath, { cwd });
  return publishRecipe(recipe, {
    cwd,
    bundlePath,
    outputDir,
    attach,
    notesRef,
    verify,
    replay,
    releaseTag,
  });
}
