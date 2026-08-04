import { replayRecipe } from "../core/replay.js";
import {
  describeResolvedRecipeRef,
  resolveRecipeRefInput,
  serializeResolvedRecipeRef,
} from "../core/refs.js";
import { readRecipeBundle } from "../core/storage.js";

export async function runDiffReplayCommand({ positionals, options }) {
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

  console.log(`Replay status: ${result.status}`);
  for (const line of describeResolvedRecipeRef(resolved)) {
    console.log(line);
  }
  console.log(`Applied checkpoints: ${result.appliedCheckpoints}/${result.totalCheckpoints}`);
  console.log(`Matched tests: ${result.matchedTests}/${result.totalTests}`);
  console.log("");

  if (result.diff.trim()) {
    console.log(result.diff);
  } else {
    console.log("No diff between replayed tree and captured target.");
  }
}
