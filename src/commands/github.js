import path from "node:path";

import { DEFAULT_NOTES_REF } from "../core/attachment.js";
import { syncPullRequestCommentFromFile } from "../core/github.js";
import { publishRecipeRef } from "../core/publish.js";

function requirePullRequestNumber(options) {
  const value = options.pr ?? options["pull-request"];
  if (!value) {
    throw new Error('Expected "--pr <number>" for "github sync-pr".');
  }
  const prNumber = Number(value);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error('Expected "--pr <number>" for "github sync-pr".');
  }
  return prNumber;
}

export async function runGitHubCommand({ positionals, options }) {
  const subcommand = positionals[0] ?? "help";
  const ref = positionals[1] ?? "HEAD";
  const cwd = options.cwd ?? process.cwd();

  if (subcommand === "help") {
    console.log(`github bridge

Usage:
  recipe github sync-pr --pr <number> [commit]

Examples:
  recipe github sync-pr --pr 123 HEAD
  recipe github sync-pr --pr 123 HEAD --verify --replay
  recipe github sync-pr --pr 123 HEAD --release-tag recipe-artifacts
`);
    return;
  }

  if (subcommand === "sync-pr") {
    const prNumber = requirePullRequestNumber(options);
    const published = await publishRecipeRef(
      ref,
      {
        cwd,
        outputDir: path.resolve(cwd, options.output ?? "outputs"),
        attach: options.attach !== false,
        notesRef: options["notes-ref"] ?? DEFAULT_NOTES_REF,
        verify: options.verify !== false,
        replay: options.replay === true,
        releaseTag: options["release-tag"] ?? null,
      },
    );

    const result = options["dry-run"] === true
      ? {
          action: "preview",
          prNumber,
          commentPath: published.commentPath,
          manifestPath: published.manifestPath,
          targetCommit: published.targetCommit,
          verification: published.verification,
          remoteArtifacts: published.remoteArtifacts,
        }
      : await syncPullRequestCommentFromFile(
          {
            prNumber,
            bodyPath: published.commentPath,
          },
          { cwd },
        );

    const response = {
      ...result,
      targetCommit: published.targetCommit,
      commentPath: published.commentPath,
      manifestPath: published.manifestPath,
      artifactPath: published.artifactPath,
      remoteArtifacts: published.remoteArtifacts,
    };

    if (options.json) {
      console.log(JSON.stringify(response, null, 2));
      return;
    }

    console.log(`GitHub PR sync ${response.action}
  pr:       ${prNumber}
  target:   ${response.targetCommit}
  comment:  ${response.commentPath}
  manifest: ${response.manifestPath}`);
    if (response.remoteArtifacts?.artifactUrl) {
      console.log(`  bundle:   ${response.remoteArtifacts.artifactUrl}`);
    }
    if (response.repo) {
      console.log(`  repo:     ${response.repo}`);
    }
    if (response.commentId) {
      console.log(`  comment:  ${response.commentId}`);
    }
    return;
  }

  throw new Error(`Unknown github subcommand "${subcommand}".`);
}
