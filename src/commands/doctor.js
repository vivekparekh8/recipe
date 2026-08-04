import { zstdCompressSync } from "node:zlib";

import { detectAgents } from "../core/environment.js";
import { resolveCommit, resolveRepoRoot, runGit } from "../core/git.js";
import { inspectRecipeHook } from "../core/hooks.js";
import { collectProjectStatus } from "./status.js";

function check(id, status, message, fix = null) {
  return { id, status, message, fix };
}

async function gitConfig(cwd, key) {
  try {
    return (await runGit(["config", "--get", key], { cwd })).stdout.trim();
  } catch {
    return "";
  }
}

export async function runDoctorCommand({ options }) {
  const cwd = options.cwd ?? process.cwd();
  const checks = [];
  let repoRoot;
  try {
    repoRoot = await resolveRepoRoot(cwd);
    checks.push(check("git-repository", "pass", "Git repository detected."));
  } catch {
    checks.push(check("git-repository", "blocker", "Not inside a Git repository.", "Run Recipe inside a Git repository."));
  }

  if (repoRoot) {
    try {
      await resolveCommit("HEAD", { cwd: repoRoot });
      checks.push(check("git-head", "pass", "Repository has a HEAD commit."));
    } catch {
      checks.push(check("git-head", "blocker", "Repository has no HEAD commit.", "Create an initial commit."));
    }
  }

  const nodeOk = Number(process.versions.node.split(".")[0]) >= 22;
  checks.push(check("node-version", nodeOk ? "pass" : "blocker", `Node.js ${process.versions.node}.`, "Install Node.js 22 or newer."));
  checks.push(check("zstd", typeof zstdCompressSync === "function" ? "pass" : "blocker", "Node.js zstd support is available.", "Use a Node.js build with zstd support."));

  if (repoRoot) {
    const [name, email] = await Promise.all([
      gitConfig(repoRoot, "user.name"),
      gitConfig(repoRoot, "user.email"),
    ]);
    checks.push(check(
      "git-identity",
      name && email ? "pass" : "blocker",
      name && email ? "Git author identity is configured." : "Git author identity is incomplete.",
      "Set Git user.name and user.email.",
    ));

    let projectStatus;
    try {
      projectStatus = await collectProjectStatus(repoRoot);
    } catch {
      projectStatus = null;
    }
    checks.push(check(
      "initialized",
      projectStatus?.initialized ? "pass" : "blocker",
      projectStatus?.initialized ? `Recipe ${projectStatus.version} is initialized.` : "Recipe is not initialized.",
      'Run "recipe init".',
    ));

    const hook = await inspectRecipeHook(repoRoot);
    checks.push(check(
      "post-commit-hook",
      hook.managed ? "pass" : "warning",
      hook.managed ? "Recipe's managed post-commit block is installed." : hook.compatible ? "Recipe's post-commit block is not installed." : "The existing post-commit hook is not a supported shell script.",
      hook.compatible ? 'Run "recipe hooks install".' : 'Chain "recipe hooks run-post-commit" from the existing hook.',
    ));
    checks.push(check(
      "worktree",
      projectStatus?.dirty ? "warning" : "pass",
      projectStatus?.dirty ? "Working tree has uncommitted changes." : "Working tree is clean.",
      projectStatus?.dirty ? "Commit or stash unrelated changes before starting a new run." : null,
    ));
    checks.push(check(
      "active-run",
      projectStatus?.runState === "stale" ? "warning" : "pass",
      `Run state is ${projectStatus?.runState ?? "unknown"}.`,
      projectStatus?.runState === "stale" ? 'Resume with "recipe run --resume" or discard with "recipe run --abort".' : null,
    ));
  }

  const agents = await detectAgents();
  checks.push(check(
    "agents",
    agents.length ? "pass" : "warning",
    agents.length ? `Detected: ${agents.map((agent) => agent.name).join(", ")}.` : "No supported agent commands were detected on PATH.",
    agents.length ? null : "Install Codex, Claude Code, or Aider, or invoke another command with recipe run.",
  ));

  const blockers = checks.filter((item) => item.status === "blocker").length;
  const warnings = checks.filter((item) => item.status === "warning").length;
  const result = { ok: blockers === 0, blockers, warnings, checks };
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const item of checks) {
      console.log(`${item.status.toUpperCase().padEnd(7)} ${item.message}${item.fix && item.status !== "pass" ? ` Fix: ${item.fix}` : ""}`);
    }
    console.log(`\n${result.ok ? "Recipe is ready" : "Recipe has blocking issues"}; ${warnings} warning(s).`);
  }
  if (!result.ok) {
    process.exitCode = 1;
  }
}
