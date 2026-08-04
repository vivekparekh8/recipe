import { verifyRecipeRef } from "../core/verify.js";
import {
  describeResolvedRecipeRef,
  resolveRecipeRefInput,
  serializeResolvedRecipeRef,
} from "../core/refs.js";

export async function runVerifyCommand({ positionals, options }) {
  const inputRef = positionals[0] ?? "HEAD";
  const cwd = options.cwd ?? process.cwd();
  const resolved = await resolveRecipeRefInput(inputRef, { cwd });
  const result = await verifyRecipeRef(resolved.resolvedRef, {
    cwd,
    notesRef: options["notes-ref"],
    replay: options.replay === true,
  });

  if (options.json) {
    console.log(JSON.stringify({
      ...result,
      resolved: serializeResolvedRecipeRef(resolved),
    }, null, 2));
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }

  const passedCount = result.checks.filter((check) => check.ok).length;
  console.log(`Verify ${result.ok ? "pass" : "fail"}`);
  console.log(`  recipe:     ${result.recipeId ?? "(unresolved)"}`);
  console.log(`  target:     ${result.targetCommit ?? "(unknown)"}`);
  console.log(`  bundle:     ${result.bundlePath ?? "(unresolved)"}`);
  console.log(`  attached:   ${result.attached ? "yes" : "no"}`);
  for (const line of describeResolvedRecipeRef(resolved)) {
    console.log(line);
  }
  console.log(`  checks:     ${passedCount} passed, ${result.warningCount} warnings, ${result.failureCount} failures`);

  if (result.replay) {
    console.log(`  replay:     ${result.replay.status} (${result.replay.appliedCheckpoints}/${result.replay.totalCheckpoints} checkpoints, ${result.replay.matchedTests}/${result.replay.totalTests} tests)`);
  } else {
    console.log("  replay:     skipped");
  }

  const warnings = result.checks.filter((check) => !check.ok && check.level === "warning");
  if (warnings.length > 0) {
    console.log("");
    console.log("Warnings:");
    for (const warning of warnings) {
      console.log(`  - ${warning.id}: ${warning.message}`);
    }
  }

  const failures = result.checks.filter((check) => !check.ok && check.level !== "warning");
  if (failures.length > 0) {
    console.log("");
    console.log("Failures:");
    for (const failure of failures) {
      console.log(`  - ${failure.id}: ${failure.message}`);
    }
  }

  if (options.verbose) {
    console.log("");
    console.log("Checks:");
    for (const check of result.checks) {
      const verdict = check.ok ? "ok" : check.level;
      console.log(`  - [${verdict}] ${check.id}: ${check.message}`);
    }
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}
