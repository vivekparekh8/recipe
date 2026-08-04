import { readRecipeAttachment } from "../core/attachment.js";
import { detectAgents, isProcessAlive } from "../core/environment.js";
import { resolveCommit, runGit } from "../core/git.js";
import { inspectRecipeHook } from "../core/hooks.js";
import { readActiveSession, readCaptureSession } from "../core/session.js";
import { readProjectConfig } from "./init.js";

async function worktreeDirty(cwd) {
  const result = await runGit(["status", "--porcelain=v1", "--untracked-files=all"], { cwd });
  return Boolean(result.stdout.trim());
}

async function activeRunState(cwd) {
  const active = await readActiveSession({ cwd });
  if (!active?.sessionId) {
    return "idle";
  }
  try {
    await readCaptureSession(active.sessionId, { cwd });
  } catch {
    return "stale";
  }
  if (active.state === "awaiting_commit") {
    return "awaiting_commit";
  }
  if (active.state === "stale" || isProcessAlive(active.pid) === false) {
    return "stale";
  }
  return "running";
}

export async function collectProjectStatus(cwd) {
  const project = await readProjectConfig({ cwd });
  const head = await resolveCommit("HEAD", { cwd });
  const hook = await inspectRecipeHook(cwd);
  const attachment = await readRecipeAttachment(head, { cwd });
  return {
    initialized: Boolean(project.config),
    version: project.config?.version ?? null,
    repoRoot: project.repoRoot,
    head,
    dirty: await worktreeDirty(cwd),
    runState: await activeRunState(cwd),
    hook: {
      path: hook.path,
      installed: hook.managed,
      compatible: hook.compatible,
    },
    agents: await detectAgents(),
    lastAttachedRecipe: attachment?.fields?.["Recipe-Id"] ?? null,
  };
}

export async function runStatusCommand({ options }) {
  const status = await collectProjectStatus(options.cwd ?? process.cwd());
  if (options.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  console.log(`Recipe status:
  initialized: ${status.initialized ? `yes (${status.version})` : "no"}
  HEAD:        ${status.head}
  worktree:    ${status.dirty ? "dirty" : "clean"}
  run:         ${status.runState}
  hook:        ${status.hook.installed ? "installed" : status.hook.compatible ? "not installed" : "incompatible"}
  agents:      ${status.agents.map((agent) => agent.name).join(", ") || "none"}
  last recipe: ${status.lastAttachedRecipe ?? "none"}`);
}
