import { resolveRecipeRefFromPullRequest } from "./github.js";

function parsePullRequestRef(ref) {
  const match = /^(?:pr|pull|pull-request):(\d+)(?:#(\d+)|@([0-9a-f]{4,40}))?$/i.exec(ref);
  if (!match) {
    return null;
  }
  return {
    prNumber: Number(match[1]),
    commentId: match[2] ? Number(match[2]) : null,
    targetCommitPrefix: match[3] ?? null,
  };
}

export async function resolveRecipeRefInput(
  ref,
  { cwd, env } = {},
) {
  const parsed = parsePullRequestRef(ref);
  if (!parsed) {
    return {
      kind: "direct",
      input: ref,
      resolvedRef: ref,
      source: "direct",
      metadata: null,
    };
  }

  const resolved = await resolveRecipeRefFromPullRequest(
    parsed.prNumber,
    {
      cwd,
      env,
      selector: {
        commentId: parsed.commentId,
        targetCommitPrefix: parsed.targetCommitPrefix,
      },
    },
  );
  return {
    kind: "pull_request",
    input: ref,
    resolvedRef: resolved.ref,
    source: resolved.kind,
    metadata: {
      prNumber: parsed.prNumber,
      selector: {
        commentId: parsed.commentId,
        targetCommitPrefix: parsed.targetCommitPrefix,
      },
      commentId: resolved.commentId ?? null,
      urls: resolved.urls ?? null,
      pullRequest: resolved.pullRequest ?? null,
      candidates: resolved.candidates ?? [],
      selected: resolved.selected ?? null,
      ambiguous: resolved.ambiguous ?? false,
      selectionReason: resolved.selectionReason ?? null,
      manifest: resolved.manifest ?? null,
      release: resolved.release ?? null,
    },
  };
}

function shortCommit(value) {
  if (!value) {
    return value;
  }
  return value.slice(0, 12);
}

export function describeResolvedRecipeRef(resolved) {
  if (resolved.kind !== "pull_request") {
    return [];
  }

  const lines = [
    `  pr:      #${resolved.metadata.prNumber}`,
    `  via:     ${resolved.source}`,
  ];

  if (resolved.metadata.commentId) {
    lines.push(`  comment:  #${resolved.metadata.commentId}`);
  }
  if (resolved.metadata.selected?.targetCommit) {
    lines.push(`  recipe:   ${shortCommit(resolved.metadata.selected.targetCommit)}`);
  }
  if (resolved.metadata.urls?.manifestUrl) {
    lines.push(`  manifest: ${resolved.metadata.urls.manifestUrl}`);
  }
  if (resolved.metadata.urls?.summaryUrl) {
    lines.push(`  summary:  ${resolved.metadata.urls.summaryUrl}`);
  }
  if (resolved.metadata.urls?.releaseUrl) {
    lines.push(`  release:  ${resolved.metadata.urls.releaseUrl}`);
  }

  const candidates = resolved.metadata.candidates ?? [];
  if (candidates.length > 1) {
    const suggestions = candidates
      .map((candidate) => (
        `pr:${resolved.metadata.prNumber}#${candidate.id} or pr:${resolved.metadata.prNumber}@${shortCommit(candidate.targetCommit)}`
      ))
      .join("; ");
    const reason = resolved.metadata.selectionReason === "latest_comment"
      ? "latest comment selected"
      : resolved.metadata.selectionReason ?? "selected";
    lines.push(`  recipes:  ${candidates.length} (${reason})`);
    lines.push(`  select:   ${suggestions}`);
  }

  return lines;
}

export function serializeResolvedRecipeRef(resolved) {
  if (!resolved) {
    return null;
  }

  return {
    kind: resolved.kind,
    input: resolved.input,
    resolvedRef: resolved.resolvedRef,
    source: resolved.source,
    metadata: resolved.metadata,
  };
}
