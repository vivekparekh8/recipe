import { randomUUID } from "node:crypto";

import {
  EVENT_TYPES,
  PROVENANCE_STATUSES,
  RECIPE_SCHEMA_VERSION,
} from "./constants.js";
import { getDiff } from "./git.js";
import { buildAttributionIndex, extractTouchedFiles } from "./patch.js";
import { sanitizeDraftPrivacy } from "./privacy.js";
import {
  buildProvenanceTimeline,
  renderProvenanceTimelineMarkdown,
} from "./provenance.js";
import { assertValidRecipe } from "./schema.js";
import { sha256Hex, stableStringify } from "./utils.js";

function normalizeEvent(event, index) {
  const normalized = {
    id: event.id ?? `event-${String(index + 1).padStart(3, "0")}`,
    type: event.type,
    at: event.at ?? null,
    actor: event.actor ?? null,
    summary: event.summary ?? null,
  };

  if (event.command) {
    normalized.command = event.command;
  }
  if (event.patch) {
    normalized.patch = event.patch;
  }
  if (event.result) {
    normalized.result = event.result;
  }
  if (event.toolName) {
    normalized.toolName = event.toolName;
  }
  if (event.inputs) {
    normalized.inputs = event.inputs;
  }
  if (event.outputs) {
    normalized.outputs = event.outputs;
  }
  if (event.files) {
    normalized.files = event.files;
  }
  if (event.causedByEventId) {
    normalized.causedByEventId = event.causedByEventId;
  }

  return normalized;
}

function isPatchEvent(event) {
  return (event.type === "file_edit_checkpoint" || event.type === "human_edit")
    && Boolean(event.patch);
}

export function deriveProvenanceStatus(events, explicitStatus) {
  if (explicitStatus && PROVENANCE_STATUSES.has(explicitStatus)) {
    return explicitStatus;
  }

  const hasHumanEdit = events.some((event) => event.type === "human_edit");
  const hasManualOverride = events.some(
    (event) => event.type === "approval" && event.summary === "manual override",
  );

  if (hasManualOverride) {
    return "manual_override";
  }
  if (hasHumanEdit) {
    return "ai_plus_human";
  }
  return "pure_ai";
}

async function deriveFinalPatch(recipe, cwd) {
  if (recipe.outputs?.finalPatch) {
    return recipe.outputs.finalPatch;
  }

  if (recipe.repo?.baseCommit && recipe.repo?.targetCommit) {
    try {
      return await getDiff(recipe.repo.baseCommit, recipe.repo.targetCommit, { cwd });
    } catch {
      return "";
    }
  }

  return "";
}

export async function normalizeRecipe(draft, { cwd } = {}) {
  const createdAt = draft.metadata?.createdAt ?? new Date().toISOString();
  const capturedAt = draft.metadata?.capturedAt ?? createdAt;
  const finalPatch = await deriveFinalPatch(draft, cwd);
  const preparedDraft = {
    ...draft,
    outputs: {
      ...draft.outputs,
      finalPatch,
    },
  };
  const privacySanitized = sanitizeDraftPrivacy(preparedDraft);
  const sanitizedDraft = privacySanitized.draft;
  const events = (sanitizedDraft.events ?? []).map(normalizeEvent);

  const touchedFiles = sanitizedDraft.outputs?.touchedFiles?.length
    ? [...new Set(sanitizedDraft.outputs.touchedFiles)]
    : [
        ...new Set([
          ...extractTouchedFiles(finalPatch),
          ...events
            .filter(isPatchEvent)
            .flatMap((event) => extractTouchedFiles(event.patch)),
        ]),
      ];

  const recipe = {
    metadata: {
      schemaVersion: RECIPE_SCHEMA_VERSION,
      recipeId: draft.metadata?.recipeId ?? randomUUID(),
      sourceAgent: draft.metadata?.sourceAgent ?? "unknown",
      adapterVersion: draft.metadata?.adapterVersion ?? "0.1.0",
      createdAt,
      capturedAt,
      targetSha256: null,
    },
    repo: {
      remoteFingerprint: draft.repo?.remoteFingerprint ?? null,
      baseCommit: sanitizedDraft.repo?.baseCommit ?? null,
      targetCommit: sanitizedDraft.repo?.targetCommit ?? null,
      treeFingerprint: sanitizedDraft.repo?.treeFingerprint ?? null,
    },
    instructions: {
      prompts: sanitizedDraft.instructions?.prompts ?? [],
      referencedArtifacts: sanitizedDraft.instructions?.referencedArtifacts ?? [],
      promptRevisions: sanitizedDraft.instructions?.promptRevisions ?? [],
    },
    events,
    outputs: {
      finalPatch,
      touchedFiles,
      replayResult: sanitizedDraft.outputs?.replayResult ?? null,
      provenanceStatus: deriveProvenanceStatus(
        events,
        sanitizedDraft.outputs?.provenanceStatus,
      ),
    },
    privacy: {
      redactions: sanitizedDraft.privacy?.redactions ?? [],
      omittedBlobs: sanitizedDraft.privacy?.omittedBlobs ?? [],
      secretScanFindings: sanitizedDraft.privacy?.secretScanFindings ?? [],
    },
  };

  const canonical = stableStringify(recipe);
  recipe.metadata.targetSha256 = sha256Hex(canonical);

  assertValidRecipe(recipe);
  return recipe;
}

export function summarizeRecipe(recipe) {
  const humanEditCount = recipe.events.filter((event) => event.type === "human_edit").length;
  const checkpointCount = recipe.events.filter((event) => (
    event.type === "file_edit_checkpoint" || event.type === "human_edit"
  )).length;
  return {
    recipeId: recipe.metadata.recipeId,
    sourceAgent: recipe.metadata.sourceAgent,
    baseCommit: recipe.repo.baseCommit,
    targetCommit: recipe.repo.targetCommit,
    provenanceStatus: recipe.outputs.provenanceStatus,
    promptCount: recipe.instructions.prompts.length,
    eventCount: recipe.events.length,
    checkpointCount,
    humanEditCount,
    touchedFiles: recipe.outputs.touchedFiles,
  };
}

export function buildTrailerBlock(recipe) {
  return [
    `Recipe-Id: ${recipe.metadata.recipeId}`,
    `Recipe-Base: ${recipe.repo.baseCommit ?? "unknown"}`,
    `Recipe-SHA256: ${recipe.metadata.targetSha256}`,
    `Recipe-Status: ${recipe.outputs.provenanceStatus}`,
  ].join("\n");
}

export function buildMarkdownSummary(recipe) {
  const summary = summarizeRecipe(recipe);
  const attribution = buildAttributionIndex(recipe.events);
  const timeline = buildProvenanceTimeline(recipe.events);
  const files = summary.touchedFiles.length ? summary.touchedFiles : ["(none)"];

  const fileSections = files
    .map((file) => {
      const ranges = attribution.get(file) ?? [];
      const renderedRanges = ranges.length
        ? ranges.map((range) => {
          const cause = range.causeEventId
            ? ` <- ${range.causeEventType} (${range.causeEventId})`
            : "";
          return `- lines ${range.start}-${range.end}: ${range.eventId}${cause}`;
        }).join("\n")
        : "- no line attribution captured";
      return `### ${file}\n${renderedRanges}`;
    })
    .join("\n\n");

  return `# recipe summary

## Commit provenance

- recipe id: ${summary.recipeId}
- source agent: ${summary.sourceAgent}
- base commit: ${summary.baseCommit}
- target commit: ${summary.targetCommit}
- provenance status: ${summary.provenanceStatus}
- prompts captured: ${summary.promptCount}
- events captured: ${summary.eventCount}
- checkpoints captured: ${summary.checkpointCount}
- human edits captured: ${summary.humanEditCount}

## Trailers

\`\`\`
${buildTrailerBlock(recipe)}
\`\`\`

## Timeline

${renderProvenanceTimelineMarkdown(timeline)}

## Files

${fileSections}
`;
}

function buildReplayCommand(targetCommit) {
  return `recipe verify ${targetCommit} --replay`;
}

export function summarizeVerificationResult(verification) {
  if (!verification) {
    return null;
  }

  return {
    ok: verification.ok,
    warningCount: verification.warningCount,
    failureCount: verification.failureCount,
    replay: verification.replay
      ? {
          status: verification.replay.status,
          appliedCheckpoints: verification.replay.appliedCheckpoints,
          totalCheckpoints: verification.replay.totalCheckpoints,
          matchedTests: verification.replay.matchedTests,
          totalTests: verification.replay.totalTests,
        }
      : null,
  };
}

export function buildReviewComment(
  recipe,
  {
    verification = null,
    remoteArtifacts = null,
  } = {},
) {
  const summary = summarizeRecipe(recipe);
  const timeline = buildProvenanceTimeline(recipe.events);
  const verifySummary = summarizeVerificationResult(verification);
  const commands = [
    `recipe inspect ${summary.targetCommit}`,
    `recipe inspect ${summary.targetCommit} --timeline`,
    buildReplayCommand(summary.targetCommit),
    `recipe replay ${summary.targetCommit}`,
  ];
  if (remoteArtifacts?.artifactUrl) {
    commands.push(`recipe inspect ${remoteArtifacts.artifactUrl}`);
    commands.push(`recipe verify ${remoteArtifacts.artifactUrl}`);
    commands.push(`recipe replay ${remoteArtifacts.artifactUrl}`);
  }

  const remoteLines = [];
  if (remoteArtifacts?.artifactUrl) {
    remoteLines.push(`- bundle: ${remoteArtifacts.artifactUrl}`);
  }
  if (remoteArtifacts?.summaryUrl) {
    remoteLines.push(`- summary: ${remoteArtifacts.summaryUrl}`);
  }
  if (remoteArtifacts?.manifestUrl) {
    remoteLines.push(`- manifest: ${remoteArtifacts.manifestUrl}`);
  }
  if (remoteArtifacts?.releaseUrl) {
    remoteLines.push(`- release: ${remoteArtifacts.releaseUrl}`);
  }

  return `## recipe for ${summary.targetCommit.slice(0, 12)}

- recipe id: ${summary.recipeId}
- source agent: ${summary.sourceAgent}
- provenance status: ${summary.provenanceStatus}
- prompts: ${summary.promptCount}
- events: ${summary.eventCount}
- checkpoints: ${summary.checkpointCount}
- human edits: ${summary.humanEditCount}
- files: ${summary.touchedFiles.join(", ") || "(none)"}
- timeline steps: ${timeline.length}
- verification: ${verifySummary ? (verifySummary.ok ? "pass" : "fail") : "not run"}
${verifySummary ? `- verification details: ${verifySummary.failureCount} failures, ${verifySummary.warningCount} warnings` : ""}
${verifySummary?.replay ? `- replay: ${verifySummary.replay.status} (${verifySummary.replay.appliedCheckpoints}/${verifySummary.replay.totalCheckpoints} checkpoints, ${verifySummary.replay.matchedTests}/${verifySummary.replay.totalTests} tests)` : ""}

${remoteLines.length > 0 ? `### Download\n\n${remoteLines.join("\n")}\n\n` : ""}### Inspect locally

\`\`\`bash
${commands.join("\n")}
\`\`\`
`;
}

export function buildPublishManifest(
  recipe,
  artifactPaths,
  {
    verification = null,
    remoteArtifacts = null,
  } = {},
) {
  const summary = summarizeRecipe(recipe);
  const commands = {
    inspect: `recipe inspect ${summary.targetCommit}`,
    timeline: `recipe inspect ${summary.targetCommit} --timeline`,
    verify: buildReplayCommand(summary.targetCommit),
    replay: `recipe replay ${summary.targetCommit}`,
    githubSync: `recipe github sync-pr --pr <number> ${summary.targetCommit}`,
  };
  if (remoteArtifacts?.artifactUrl) {
    commands.inspectRemote = `recipe inspect ${remoteArtifacts.artifactUrl}`;
    commands.verifyRemote = `recipe verify ${remoteArtifacts.artifactUrl}`;
    commands.replayRemote = `recipe replay ${remoteArtifacts.artifactUrl}`;
  }

  return {
    schemaVersion: RECIPE_SCHEMA_VERSION,
    recipeId: summary.recipeId,
    sourceAgent: summary.sourceAgent,
    baseCommit: summary.baseCommit,
    targetCommit: summary.targetCommit,
    provenanceStatus: summary.provenanceStatus,
    touchedFiles: summary.touchedFiles,
    artifactPaths,
    remoteArtifacts,
    commands,
    verification: summarizeVerificationResult(verification),
  };
}
