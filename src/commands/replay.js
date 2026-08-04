import { replayRecipe } from "../core/replay.js";
import {
  describeResolvedRecipeRef,
  resolveRecipeRefInput,
  serializeResolvedRecipeRef,
} from "../core/refs.js";
import { readRecipeBundle } from "../core/storage.js";

export async function runReplayCommand({ positionals, options }) {
  const inputRef = positionals[0] ?? "HEAD";
  const cwd = options.cwd ?? process.cwd();
  const resolved = await resolveRecipeRefInput(inputRef, { cwd });
  const recipe = await readRecipeBundle(resolved.resolvedRef, { cwd });
  const result = await replayRecipe(recipe, { cwd });
  if (!result.success) {
    process.exitCode = 1;
  }

  if (options.json) {
    console.log(JSON.stringify({
      ...result,
      resolved: serializeResolvedRecipeRef(resolved),
    }, null, 2));
    return;
  }

  console.log(`Replay ${result.status}`);
  for (const line of describeResolvedRecipeRef(resolved)) {
    console.log(line);
  }
  console.log(`  checkpoints: ${result.appliedCheckpoints}/${result.totalCheckpoints}`);
  console.log(`  agent edits: ${result.appliedAgentCheckpoints}/${result.totalAgentCheckpoints}`);
  console.log(`  human edits: ${result.appliedHumanEdits}/${result.totalHumanEdits}`);
  console.log(`  tests:       ${result.matchedTests}/${result.totalTests}`);
  console.log(`  worktree:    ${result.worktreePath ?? "(cleaned up)"}`);

  if (result.failedCheckpoint) {
    console.log(`  failed checkpoint: ${result.failedCheckpoint}`);
  }

  for (const testRun of result.testRuns) {
    const verdict = testRun.matched ? "matched" : "mismatch";
    console.log(`  test ${testRun.command} -> ${testRun.actualExitCode} (${verdict})`);
  }
}
