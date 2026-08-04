import { DEFAULT_NOTES_REF, readRecipeAttachment } from "../core/attachment.js";
import { buildAttributionIndex, findAttributionForLine } from "../core/patch.js";
import {
  buildProvenanceTimeline,
  renderProvenanceTimelineText,
} from "../core/provenance.js";
import { summarizeRecipe, buildTrailerBlock } from "../core/recipe.js";
import { describeResolvedRecipeRef, resolveRecipeRefInput } from "../core/refs.js";
import { readRecipeBundle, resolveRecipePath } from "../core/storage.js";

function parseLineSelector(value) {
  const separator = value.lastIndexOf(":");
  if (separator === -1) {
    throw new Error('Expected "--line <path:line-number>".');
  }

  const filePath = value.slice(0, separator);
  const lineText = value.slice(separator + 1);
  const lineNumber = Number(lineText);
  if (!filePath || !Number.isInteger(lineNumber) || lineNumber <= 0) {
    throw new Error('Expected "--line <path:line-number>".');
  }

  return {
    filePath,
    lineNumber,
  };
}

export async function runInspectCommand({ positionals, options }) {
  const inputRef = positionals[0] ?? "HEAD";
  const cwd = options.cwd ?? process.cwd();
  const resolved = await resolveRecipeRefInput(inputRef, { cwd });
  const recipe = await readRecipeBundle(resolved.resolvedRef, { cwd });

  if (options.json) {
    console.log(JSON.stringify(recipe, null, 2));
    return;
  }

  const summary = summarizeRecipe(recipe);
  const bundlePath = await resolveRecipePath(resolved.resolvedRef, { cwd });
  const attachment = await readRecipeAttachment(
    summary.targetCommit,
    {
      cwd,
      notesRef: options["notes-ref"] ?? DEFAULT_NOTES_REF,
    },
  );
  console.log(`Recipe ${summary.recipeId}`);
  console.log(`  bundle: ${bundlePath}`);
  console.log(`  source: ${summary.sourceAgent}`);
  console.log(`  base:   ${summary.baseCommit}`);
  console.log(`  target: ${summary.targetCommit}`);
  console.log(`  status: ${summary.provenanceStatus}`);
  console.log(`  prompts: ${summary.promptCount}`);
  console.log(`  events:  ${summary.eventCount}`);
  console.log(`  checkpoints: ${summary.checkpointCount}`);
  console.log(`  human edits: ${summary.humanEditCount}`);
  console.log(`  files:   ${summary.touchedFiles.join(", ") || "(none)"}`);
  console.log(`  attached: ${attachment ? "yes" : "no"}`);
  for (const line of describeResolvedRecipeRef(resolved)) {
    console.log(line);
  }
  console.log(`  redactions: ${recipe.privacy.redactions.length}`);
  console.log(`  secret findings: ${recipe.privacy.secretScanFindings.length}`);
  console.log("");

  if (options.timeline) {
    const timeline = buildProvenanceTimeline(recipe.events);
    console.log("Timeline:");
    console.log(renderProvenanceTimelineText(timeline));
    console.log("");
  }

  if (options.line) {
    const selector = parseLineSelector(options.line);
    const attribution = buildAttributionIndex(recipe.events);
    const match = findAttributionForLine(
      attribution,
      selector.filePath,
      selector.lineNumber,
    );

    if (!match) {
      console.log(`No attribution found for ${selector.filePath}:${selector.lineNumber}.`);
      return;
    }

    console.log(`${selector.filePath}:${selector.lineNumber}`);
    console.log(`  checkpoint: ${match.eventType} (${match.eventId})`);
    if (match.causeEventId) {
      console.log(`  caused by:  ${match.causeEventType} (${match.causeEventId})`);
      if (match.causeSummary) {
        console.log(`  step:       ${match.causeSummary}`);
      }
    }
    if (match.promptEventId) {
      console.log(`  prompt:     ${match.promptEventId}`);
      if (match.promptSummary) {
        console.log(`  asked:      ${match.promptSummary}`);
      }
    }
    return;
  }

  if (options.file) {
    const attribution = buildAttributionIndex(recipe.events);
    const ranges = attribution.get(options.file) ?? [];
    if (ranges.length === 0) {
      console.log(`No attribution data for ${options.file}.`);
      return;
    }

    console.log(`Attribution for ${options.file}:`);
    for (const range of ranges) {
      const cause = range.causeEventId
        ? ` <- ${range.causeEventType} (${range.causeEventId})`
        : "";
      console.log(
        `  lines ${range.start}-${range.end}: ${range.eventType} (${range.eventId})${cause}`,
      );
    }
    return;
  }

  const showEvents = options.timeline ? options.events === true : options.events !== false;
  if (showEvents) {
    console.log("Events:");
    for (const event of recipe.events) {
      const label = event.summary ?? event.command ?? event.name ?? "";
      console.log(`  - ${event.id}: ${event.type}${label ? ` :: ${label}` : ""}`);
    }
    console.log("");
  }

  console.log("Trailers:");
  console.log(buildTrailerBlock(recipe));

  if (attachment) {
    console.log("");
    console.log(`Attachment note (${attachment.notesRef}):`);
    console.log(attachment.note);
  }
}
