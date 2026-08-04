import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runGit, runShell, withTempWorktree } from "./git.js";
import { extractTouchedFiles } from "./patch.js";

function isReplayCheckpoint(event) {
  return event.type === "file_edit_checkpoint" || event.type === "human_edit";
}

async function applyCheckpoint(worktreePath, patchText, index) {
  const patchDir = await mkdtemp(path.join(os.tmpdir(), "recipe-patch-"));
  const patchPath = path.join(
    patchDir,
    `checkpoint-${index + 1}.diff`,
  );
  await writeFile(patchPath, patchText, "utf8");

  try {
    await runGit(
      ["apply", "--3way", "--recount", "--whitespace=nowarn", patchPath],
      { cwd: worktreePath },
    );
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
    };
  } finally {
    await rm(patchDir, { recursive: true, force: true });
  }
}

function classifyReplay({ diff, failedCheckpoint, appliedCheckpoints, totalCheckpoints }) {
  if (!diff.trim() && !failedCheckpoint) {
    return "exact";
  }

  if (!failedCheckpoint && appliedCheckpoints === totalCheckpoints) {
    return "mixed";
  }

  return "drifted";
}

export async function replayRecipe(recipe, { cwd, keepWorktree = false } = {}) {
  const checkpoints = recipe.events.filter(isReplayCheckpoint);
  const tests = recipe.events.filter((event) => event.type === "test_run");
  const totalHumanEdits = checkpoints.filter((event) => event.type === "human_edit").length;
  const totalAgentCheckpoints = checkpoints.filter(
    (event) => event.type === "file_edit_checkpoint",
  ).length;
  const sparsePaths = tests.length === 0 ? recipe.outputs.touchedFiles : [];

  return withTempWorktree(
    recipe.repo.baseCommit,
    { cwd, keep: keepWorktree, sparsePaths },
    async (worktreePath) => {
      const testRuns = [];
      let appliedCheckpoints = 0;
      let appliedHumanEdits = 0;
      let appliedAgentCheckpoints = 0;
      let failedCheckpoint = null;
      let failedCheckpointError = null;

      for (const event of recipe.events) {
        if (isReplayCheckpoint(event)) {
          const applyResult = await applyCheckpoint(
            worktreePath,
            event.patch ?? "",
            appliedCheckpoints,
          );
          if (!applyResult.ok) {
            failedCheckpoint = event.id;
            failedCheckpointError = applyResult.error;
            break;
          }
          appliedCheckpoints += 1;
          if (event.type === "human_edit") {
            appliedHumanEdits += 1;
          } else {
            appliedAgentCheckpoints += 1;
          }
        }

        if (event.type === "test_run" && event.command) {
          const result = await runShell(event.command, { cwd: worktreePath });
          const expectedExitCode = event.result?.exitCode ?? 0;
          testRuns.push({
            command: event.command,
            expectedExitCode,
            actualExitCode: result.code,
            matched: expectedExitCode === result.code,
            stdout: result.stdout,
            stderr: result.stderr,
          });
        }
      }

      const diffResult = await runGit(
        ["diff", "--binary", recipe.repo.targetCommit],
        { cwd: worktreePath },
      );

      const expectedFiles = new Set(recipe.outputs.touchedFiles);
      const replayFiles = new Set(extractTouchedFiles(diffResult.stdout));
      const overlapFiles = [...expectedFiles].filter((file) => replayFiles.has(file));
      const matchedTests = testRuns.filter((testRun) => testRun.matched).length;
      const status = classifyReplay({
        diff: diffResult.stdout,
        failedCheckpoint,
        appliedCheckpoints,
        totalCheckpoints: checkpoints.length,
      });
      const success = status === "exact" && matchedTests === tests.length;

      return {
        status,
        success,
        worktreePath: keepWorktree ? worktreePath : null,
        appliedCheckpoints,
        totalCheckpoints: checkpoints.length,
        appliedAgentCheckpoints,
        totalAgentCheckpoints,
        appliedHumanEdits,
        totalHumanEdits,
        matchedTests,
        totalTests: tests.length,
        failedCheckpoint,
        failedCheckpointError,
        overlapFiles,
        testRuns,
        diff: diffResult.stdout,
      };
    },
  );
}
