import path from "node:path";

import { DEFAULT_NOTES_REF } from "../core/attachment.js";
import { publishRecipeRef } from "../core/publish.js";

export async function runPublishCommand({ positionals, options }) {
  const ref = positionals[0] ?? "HEAD";
  const cwd = options.cwd ?? process.cwd();
  const result = await publishRecipeRef(
    ref,
    {
      cwd,
      outputDir: path.resolve(cwd, options.output ?? "outputs"),
      attach: options.attach !== false,
      notesRef: options["notes-ref"] ?? DEFAULT_NOTES_REF,
      verify: options.verify === true,
      replay: options.replay === true,
      releaseTag: options["release-tag"] ?? null,
    },
  );

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Generated local publish artifacts:
  summary:  ${result.summaryPath}
  trailers: ${result.trailerPath}
  bundle:   ${result.artifactPath}
  comment:  ${result.commentPath}
  manifest: ${result.manifestPath}`);
  if (result.remoteArtifacts?.artifactUrl) {
    console.log(`Remote artifact:
  bundle:   ${result.remoteArtifacts.artifactUrl}
  release:  ${result.remoteArtifacts.releaseUrl ?? "(unknown)"}`);
  }
  if (result.attachment) {
    console.log(`Attached recipe metadata:
  commit:   ${result.attachment.targetCommit}
  notes:    ${result.attachment.notesRef}`);
  }
  if (result.verification) {
    console.log(`Verification:
  status:   ${result.verification.ok ? "pass" : "fail"}
  failures: ${result.verification.failureCount}
  warnings: ${result.verification.warningCount}`);
  }
}
