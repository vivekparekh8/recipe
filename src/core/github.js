import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const COMMENT_MARKER_PREFIX = "<!-- recipe-comment:";
const COMMENT_META_PREFIX = "<!-- recipe-meta:";

export function buildGitHubCommentMarker({ recipeId, targetCommit }) {
  return `${COMMENT_MARKER_PREFIX}${recipeId}:${targetCommit} -->`;
}

function buildGitHubCommentMetadata(metadata) {
  return `${COMMENT_META_PREFIX}${JSON.stringify(metadata)} -->`;
}

function stripRecipeCommentPrefixLines(body) {
  return body
    .split(/\r?\n/)
    .filter((line) => (
      !line.startsWith(COMMENT_MARKER_PREFIX)
        && !line.startsWith(COMMENT_META_PREFIX)
    ))
    .join("\n");
}

export function addGitHubCommentMarker(
  body,
  { recipeId, targetCommit, metadata = null },
) {
  const content = stripRecipeCommentPrefixLines(body);
  const marker = buildGitHubCommentMarker({ recipeId, targetCommit });
  const lines = [marker];
  if (metadata && Object.values(metadata).some((value) => value !== null && value !== undefined)) {
    lines.push(buildGitHubCommentMetadata(metadata));
  }
  lines.push(content);
  return lines.join("\n");
}

export function extractGitHubCommentMarker(body) {
  return body
    .split(/\r?\n/)
    .find((line) => line.startsWith(COMMENT_MARKER_PREFIX))
    ?? null;
}

export function parseGitHubCommentMarker(marker) {
  if (!marker?.startsWith(COMMENT_MARKER_PREFIX)) {
    return null;
  }

  const match = /^<!-- recipe-comment:([^:]+):([0-9a-f]{7,40}) -->$/i.exec(marker.trim());
  if (!match) {
    return null;
  }

  return {
    recipeId: match[1],
    targetCommit: match[2],
  };
}

export function extractGitHubCommentMetadata(body) {
  const line = body
    .split(/\r?\n/)
    .find((value) => value.startsWith(COMMENT_META_PREFIX));
  if (!line) {
    return null;
  }

  const match = /^<!-- recipe-meta:(.+) -->$/s.exec(line.trim());
  if (!match) {
    return null;
  }

  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

export function extractRecipeUrlsFromComment(body) {
  const matches = [...body.matchAll(/https?:\/\/\S+/g)];
  const urls = matches.map((match) => match[0].replace(/[),.;]+$/, ""));
  const bundleUrl = urls.find((url) => /\.recipe\.json\.zst$/i.test(url))
    ?? urls.find((url) => /\.json\.zst$/i.test(url))
    ?? null;
  const manifestUrl = urls.find((url) => /\.recipe-publish\.json$/i.test(url)) ?? null;
  const summaryUrl = urls.find((url) => /\.recipe\.md$/i.test(url)) ?? null;
  const releaseUrl = urls.find((url) => /\/releases\/tag\//.test(url)) ?? null;

  return {
    bundleUrl,
    manifestUrl,
    summaryUrl,
    releaseUrl,
  };
}

export function parseRecipePullRequestComment(comment) {
  const marker = extractGitHubCommentMarker(comment.body ?? "");
  const parsedMarker = parseGitHubCommentMarker(marker);
  if (!parsedMarker) {
    return null;
  }

  const metadata = extractGitHubCommentMetadata(comment.body ?? "") ?? null;
  const visibleUrls = extractRecipeUrlsFromComment(comment.body ?? "");

  return {
    id: comment.id,
    recipeId: parsedMarker.recipeId,
    targetCommit: parsedMarker.targetCommit,
    marker,
    metadata,
    urls: {
      bundleUrl: metadata?.artifactUrl ?? metadata?.bundleUrl ?? visibleUrls.bundleUrl,
      manifestUrl: metadata?.manifestUrl ?? visibleUrls.manifestUrl,
      summaryUrl: metadata?.summaryUrl ?? visibleUrls.summaryUrl,
      releaseUrl: metadata?.releaseUrl ?? visibleUrls.releaseUrl,
    },
    user: comment.user?.login ?? null,
  };
}

export async function runGh(args, { cwd, env } = {}) {
  try {
    const result = await execFileAsync("gh", args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      maxBuffer: 20 * 1024 * 1024,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      code: 0,
    };
  } catch (error) {
    const message = error.stderr || error.message;
    throw new Error(message.trim() || "Failed to run gh.");
  }
}

export async function readGitHubRepoInfo({ cwd, env } = {}) {
  const result = await runGh(["repo", "view", "--json", "owner,name"], { cwd, env });
  const repo = JSON.parse(result.stdout);
  return {
    owner: repo.owner?.login ?? repo.owner,
    name: repo.name,
  };
}

export async function readGitHubViewer({ cwd, env } = {}) {
  const result = await runGh(["api", "user"], { cwd, env });
  const user = JSON.parse(result.stdout);
  return {
    login: user.login,
  };
}

export async function readPullRequestComments(
  prNumber,
  { cwd, env, repo } = {},
) {
  const resolvedRepo = repo ?? await readGitHubRepoInfo({ cwd, env });
  const endpoint = `repos/${resolvedRepo.owner}/${resolvedRepo.name}/issues/${prNumber}/comments`;
  const result = await runGh(["api", endpoint], { cwd, env });
  const comments = JSON.parse(result.stdout || "[]");
  return {
    repo: resolvedRepo,
    comments: Array.isArray(comments) ? comments : [comments],
  };
}

export async function readPullRequest(
  prNumber,
  { cwd, env, repo } = {},
) {
  const resolvedRepo = repo ?? await readGitHubRepoInfo({ cwd, env });
  const endpoint = `repos/${resolvedRepo.owner}/${resolvedRepo.name}/pulls/${prNumber}`;
  const result = await runGh(["api", endpoint], { cwd, env });
  return {
    repo: resolvedRepo,
    pullRequest: JSON.parse(result.stdout),
  };
}

function isNotFoundError(error) {
  return /404|not found/i.test(error.message);
}

export async function readGitHubReleaseByTag(
  tag,
  { cwd, env, repo } = {},
) {
  const resolvedRepo = repo ?? await readGitHubRepoInfo({ cwd, env });
  try {
    const result = await runGh(
      ["api", `repos/${resolvedRepo.owner}/${resolvedRepo.name}/releases/tags/${encodeURIComponent(tag)}`],
      { cwd, env },
    );
    return {
      repo: resolvedRepo,
      release: JSON.parse(result.stdout),
    };
  } catch (error) {
    if (isNotFoundError(error)) {
      return {
        repo: resolvedRepo,
        release: null,
      };
    }
    throw error;
  }
}

export async function ensureGitHubRelease(
  {
    tag,
    title,
    notes,
    targetCommit,
  },
  { cwd, env } = {},
) {
  const loaded = await readGitHubReleaseByTag(tag, { cwd, env });
  if (loaded.release) {
    return {
      created: false,
      repo: loaded.repo,
      release: loaded.release,
    };
  }

  await runGh(
    [
      "release",
      "create",
      tag,
      "--title",
      title,
      "--notes",
      notes,
      "--target",
      targetCommit,
      "--latest=false",
    ],
    { cwd, env },
  );

  const created = await readGitHubReleaseByTag(tag, { cwd, env, repo: loaded.repo });
  if (!created.release) {
    throw new Error(`GitHub release "${tag}" was created but could not be loaded.`);
  }

  return {
    created: true,
    repo: created.repo,
    release: created.release,
  };
}

export async function uploadGitHubReleaseAssets(
  {
    tag,
    filePaths,
  },
  { cwd, env } = {},
) {
  await runGh(
    [
      "release",
      "upload",
      tag,
      ...filePaths,
      "--clobber",
    ],
    { cwd, env },
  );

  return readGitHubReleaseByTag(tag, { cwd, env });
}

export function buildGitHubReleaseAssetIndex(release) {
  const index = new Map();
  for (const asset of release.assets ?? []) {
    index.set(asset.name, asset);
  }
  return index;
}

export function findRecipePullRequestComment(comments, viewerLogin, marker) {
  return comments.find((comment) => (
    comment.user?.login === viewerLogin
      && typeof comment.body === "string"
      && comment.body.includes(marker)
  )) ?? null;
}

export function findAnyRecipePullRequestComment(comments) {
  return comments.find((comment) => (
    typeof comment.body === "string"
      && comment.body.includes(COMMENT_MARKER_PREFIX)
  )) ?? null;
}

export function listRecipePullRequestComments(comments) {
  return comments
    .map((comment) => parseRecipePullRequestComment(comment))
    .filter(Boolean);
}

function summarizeRecipePullRequestComment(comment) {
  return {
    id: comment.id,
    recipeId: comment.recipeId,
    targetCommit: comment.targetCommit,
    bundleUrl: comment.urls.bundleUrl,
    manifestUrl: comment.urls.manifestUrl,
    summaryUrl: comment.urls.summaryUrl,
    releaseUrl: comment.urls.releaseUrl,
    releaseTag: comment.metadata?.releaseTag ?? null,
  };
}

function chooseRecipeComment(candidates, selector = {}) {
  if (candidates.length === 0) {
    return {
      selected: null,
      ambiguous: false,
      selectionReason: "none",
    };
  }

  if (selector.commentId) {
    const selected = candidates.find((candidate) => candidate.id === selector.commentId) ?? null;
    if (!selected) {
      throw new Error(`No recipe comment #${selector.commentId} found on this PR.`);
    }
    return {
      selected,
      ambiguous: false,
      selectionReason: "comment_id",
    };
  }

  if (selector.targetCommitPrefix) {
    const matches = candidates.filter((candidate) => (
      candidate.targetCommit.startsWith(selector.targetCommitPrefix)
    ));
    if (matches.length === 0) {
      throw new Error(`No recipe comment target commit starts with "${selector.targetCommitPrefix}".`);
    }
    if (matches.length > 1) {
      throw new Error(`Multiple recipe comments match target commit prefix "${selector.targetCommitPrefix}".`);
    }
    return {
      selected: matches[0],
      ambiguous: false,
      selectionReason: "target_commit_prefix",
    };
  }

  if (candidates.length === 1) {
    return {
      selected: candidates[0],
      ambiguous: false,
      selectionReason: "single_comment",
    };
  }

  const sorted = [...candidates].sort((left, right) => right.id - left.id);
  return {
    selected: sorted[0],
    ambiguous: true,
    selectionReason: "latest_comment",
  };
}

async function readRecipePublishManifestFromUrl(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch recipe publish manifest from ${url}: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function extractRemoteArtifactUrlFromManifest(manifest) {
  return manifest?.remoteArtifacts?.artifactUrl
    ?? manifest?.commands?.inspectRemote?.match(/https?:\/\/\S+/)?.[0]
    ?? null;
}

function extractRemoteSummaryUrlFromManifest(manifest) {
  return manifest?.remoteArtifacts?.summaryUrl ?? null;
}

function extractRemoteReleaseUrlFromManifest(manifest) {
  return manifest?.remoteArtifacts?.releaseUrl ?? null;
}

async function resolveRecipeCommentRef(
  selected,
  {
    cwd,
    env,
    repo,
  },
) {
  if (selected.urls.bundleUrl) {
    return {
      kind: "artifact_url",
      ref: selected.urls.bundleUrl,
      urls: selected.urls,
    };
  }

  if (selected.urls.manifestUrl) {
    const manifest = await readRecipePublishManifestFromUrl(selected.urls.manifestUrl);
    const bundleUrl = extractRemoteArtifactUrlFromManifest(manifest);
    if (bundleUrl) {
      return {
        kind: "artifact_url_manifest",
        ref: bundleUrl,
        urls: {
          bundleUrl,
          manifestUrl: selected.urls.manifestUrl,
          summaryUrl: extractRemoteSummaryUrlFromManifest(manifest) ?? selected.urls.summaryUrl,
          releaseUrl: extractRemoteReleaseUrlFromManifest(manifest) ?? selected.urls.releaseUrl,
        },
        manifest,
      };
    }
  }

  if (selected.metadata?.releaseTag && (selected.metadata?.artifactName || selected.metadata?.manifestName)) {
    const loaded = await readGitHubReleaseByTag(
      selected.metadata.releaseTag,
      { cwd, env, repo },
    );
    if (loaded.release) {
      const index = buildGitHubReleaseAssetIndex(loaded.release);
      const artifactAsset = selected.metadata.artifactName
        ? index.get(selected.metadata.artifactName)
        : null;
      if (artifactAsset?.browser_download_url) {
        return {
          kind: "artifact_url_release_asset",
          ref: artifactAsset.browser_download_url,
          urls: {
            bundleUrl: artifactAsset.browser_download_url,
            manifestUrl: selected.metadata.manifestName
              ? index.get(selected.metadata.manifestName)?.browser_download_url ?? selected.urls.manifestUrl
              : selected.urls.manifestUrl,
            summaryUrl: selected.metadata.summaryName
              ? index.get(selected.metadata.summaryName)?.browser_download_url ?? selected.urls.summaryUrl
              : selected.urls.summaryUrl,
            releaseUrl: loaded.release.html_url ?? selected.urls.releaseUrl,
          },
          release: loaded.release,
        };
      }

      const manifestAsset = selected.metadata.manifestName
        ? index.get(selected.metadata.manifestName)
        : null;
      if (manifestAsset?.browser_download_url) {
        const manifest = await readRecipePublishManifestFromUrl(manifestAsset.browser_download_url);
        const bundleUrl = extractRemoteArtifactUrlFromManifest(manifest);
        if (bundleUrl) {
          return {
            kind: "artifact_url_release_manifest",
            ref: bundleUrl,
            urls: {
              bundleUrl,
              manifestUrl: manifestAsset.browser_download_url,
              summaryUrl: extractRemoteSummaryUrlFromManifest(manifest) ?? selected.urls.summaryUrl,
              releaseUrl: loaded.release.html_url ?? selected.urls.releaseUrl,
            },
            manifest,
            release: loaded.release,
          };
        }
      }
    }
  }

  return {
    kind: "recipe_comment_commit",
    ref: selected.targetCommit,
    urls: selected.urls,
  };
}

export async function resolveRecipeRefFromPullRequest(
  prNumber,
  {
    cwd,
    env,
    selector = {},
  } = {},
) {
  const listed = await readPullRequestComments(prNumber, { cwd, env });
  const candidates = listRecipePullRequestComments(listed.comments);
  const chosen = chooseRecipeComment(candidates, selector);
  const selected = chosen.selected;

  if (selected) {
    const resolvedCommentRef = await resolveRecipeCommentRef(
      selected,
      {
        cwd,
        env,
        repo: listed.repo,
      },
    );
    return {
      kind: resolvedCommentRef.kind,
      ref: resolvedCommentRef.ref,
      commentId: selected.id,
      urls: resolvedCommentRef.urls,
      candidates: candidates.map(summarizeRecipePullRequestComment),
      selected: summarizeRecipePullRequestComment(selected),
      ambiguous: chosen.ambiguous,
      selectionReason: chosen.selectionReason,
      manifest: resolvedCommentRef.manifest ?? null,
      release: resolvedCommentRef.release ?? null,
    };
  }

  const pullRequest = await readPullRequest(prNumber, {
    cwd,
    env,
    repo: listed.repo,
  });

  return {
    kind: "pull_request_head",
    ref: pullRequest.pullRequest.head?.sha ?? pullRequest.pullRequest.head?.ref,
    commentId: null,
    urls: null,
    candidates: [],
    selected: null,
    ambiguous: false,
    selectionReason: "pull_request_head",
    pullRequest: pullRequest.pullRequest,
  };
}

async function ghApiWithJsonBody(endpoint, method, payload, { cwd, env } = {}) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "recipe-gh-"));
  const inputPath = path.join(tempDir, "payload.json");
  await writeFile(inputPath, `${JSON.stringify(payload)}\n`, "utf8");

  try {
    const result = await runGh(
      ["api", endpoint, "--method", method, "--input", inputPath],
      { cwd, env },
    );
    return JSON.parse(result.stdout || "{}");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function syncPullRequestComment(
  {
    prNumber,
    body,
  },
  { cwd, env } = {},
) {
  const marker = extractGitHubCommentMarker(body);
  if (!marker) {
    throw new Error("Recipe GitHub comment body is missing its hidden marker.");
  }

  const repo = await readGitHubRepoInfo({ cwd, env });
  const viewer = await readGitHubViewer({ cwd, env });
  const listed = await readPullRequestComments(prNumber, { cwd, env, repo });
  const existing = findRecipePullRequestComment(listed.comments, viewer.login, marker);

  if (existing) {
    const comment = await ghApiWithJsonBody(
      `repos/${repo.owner}/${repo.name}/issues/comments/${existing.id}`,
      "PATCH",
      { body },
      { cwd, env },
    );
    return {
      action: "updated",
      prNumber,
      repo: `${repo.owner}/${repo.name}`,
      viewer: viewer.login,
      commentId: comment.id ?? existing.id,
      marker,
    };
  }

  const comment = await ghApiWithJsonBody(
    `repos/${repo.owner}/${repo.name}/issues/${prNumber}/comments`,
    "POST",
    { body },
    { cwd, env },
  );
  return {
    action: "created",
    prNumber,
    repo: `${repo.owner}/${repo.name}`,
    viewer: viewer.login,
    commentId: comment.id ?? null,
    marker,
  };
}

export async function syncPullRequestCommentFromFile(
  {
    prNumber,
    bodyPath,
  },
  { cwd, env } = {},
) {
  const body = await readFile(bodyPath, "utf8");
  return syncPullRequestComment(
    {
      prNumber,
      body,
    },
    { cwd, env },
  );
}
