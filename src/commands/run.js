import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import {
  resolveCommit,
  resolveGitDir,
  runGit,
} from "../core/git.js";
import { publishRecipeRef } from "../core/publish.js";
import {
  appendPromptToSession,
  captureSessionCheckpoint,
  clearActiveSession,
  createCaptureSession,
  finalizeCaptureSession,
  readActiveSession,
  readCaptureSession,
  recordShellResultForSession,
  updateActiveSession,
} from "../core/session.js";
import { requireInitializedProject } from "./init.js";

function inferSourceAgent(command) {
  const name = path.basename(command).replace(/\.(cmd|exe)$/i, "").toLowerCase();
  if (name === "claude" || name === "claude-code") {
    return "claude-code";
  }
  return name || "unknown";
}

function displayCommand(command, args) {
  return [command, ...args].map((part) => {
    if (/^[A-Za-z0-9_./:=+@%-]+$/.test(part)) {
      return part;
    }
    return JSON.stringify(part);
  }).join(" ");
}

function defaultCommitMessage(prompt) {
  const compact = prompt.trim().replace(/\s+/g, " ");
  const subject = compact.length <= 64 ? compact : `${compact.slice(0, 61)}...`;
  return `recipe: ${subject}`;
}

async function worktreeStatus(cwd) {
  const result = await runGit(
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd },
  );
  return result.stdout.trim();
}

async function runExactProcess(command, args, { cwd, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        RECIPE_RUN_MANAGED: "1",
      },
      stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
    });

    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
    }
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({
        code: code ?? 1,
        signal: signal ?? null,
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
      });
    });
  });
}

async function assertBaseIsAncestor(baseCommit, cwd) {
  try {
    await runGit(["merge-base", "--is-ancestor", baseCommit, "HEAD"], { cwd });
  } catch {
    throw new Error("The agent rewrote history outside the captured base; Recipe will not attach an ambiguous run.");
  }
}

async function startOrResumeSession({ repoRoot, options, command }) {
  const cwd = repoRoot;
  const active = await readActiveSession({ cwd });
  if (options.resume === true) {
    if (!active?.sessionId) {
      throw new Error("There is no interrupted Recipe run to resume.");
    }
    const session = await readCaptureSession(active.sessionId, { cwd });
    await captureSessionCheckpoint(
      session.sessionId,
      {
        eventType: "human_edit",
        actor: "human",
        summary: "Changes made before resuming the agent",
      },
      { cwd },
    );
    if (options.prompt) {
      await appendPromptToSession(session.sessionId, options.prompt, {}, { cwd });
    }
    await updateActiveSession({ state: "running", pid: process.pid }, { cwd });
    return session;
  }

  if (active?.sessionId) {
    throw new Error(
      'An interrupted Recipe run is active. Use "recipe run --resume -- <command>" or "recipe run --abort".',
    );
  }
  const dirty = await worktreeStatus(cwd);
  if (dirty) {
    throw new Error(
      "Recipe run requires a clean working tree so it never commits unrelated changes.",
    );
  }

  const session = await createCaptureSession(
    {
      sourceAgent: options["source-agent"] ?? inferSourceAgent(command),
      adapterVersion: "0.1.0",
      baseRef: "HEAD",
      prompt: options.prompt,
      activate: true,
    },
    { cwd },
  );
  await updateActiveSession({ state: "running", pid: process.pid }, { cwd });
  return session;
}

async function confirmCommit() {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question("Commit captured changes and attach? [y/N] ");
    return /^y(?:es)?$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

export async function shouldCreateCommit(
  options,
  {
    interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
    confirm = confirmCommit,
  } = {},
) {
  if (options.commit === true) {
    return true;
  }
  if (options.commit === false || !interactive) {
    return false;
  }
  return confirm();
}

function printHelp() {
  console.log(`run

Usage:
  recipe run --prompt "Fix the parser bug" -- <agent command>
  recipe run --resume [--prompt "Follow-up"] -- <agent command>
  recipe run --abort

Options:
  --commit               Commit captured changes after a successful run
  --no-commit            Never prompt or commit; preserve the active run
  --message <text>       Commit message when Recipe creates the commit
  --source-agent <name> Override the agent name inferred from the command
  --json                 Capture child output and print structured result
`);
}

export async function runRunCommand({ options, passthrough }) {
  const invocationCwd = options.cwd ?? process.cwd();
  if (options.help) {
    printHelp();
    return;
  }
  const project = await requireInitializedProject({ cwd: invocationCwd });
  const cwd = project.repoRoot;

  if (options.abort === true) {
    const active = await readActiveSession({ cwd });
    await clearActiveSession({ cwd });
    const result = { aborted: Boolean(active?.sessionId) };
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(result.aborted
        ? "Aborted the active Recipe run. Working-tree changes were left untouched."
        : "No active Recipe run.");
    }
    return;
  }

  if (!passthrough?.length) {
    throw new Error('Expected an agent command after "--".');
  }
  if (options.prompt !== undefined && (
    typeof options.prompt !== "string" || !options.prompt.trim()
  )) {
    throw new Error('Expected a non-empty value for "--prompt".');
  }
  if (options.message !== undefined && (
    typeof options.message !== "string" || !options.message.trim()
  )) {
    throw new Error('Expected a non-empty value for "--message".');
  }
  if (!options.prompt && options.resume !== true) {
    throw new Error('Expected "--prompt <text>" for a new Recipe run.');
  }

  const [command, ...args] = passthrough;
  const session = await startOrResumeSession({ repoRoot: cwd, options, command });
  const commandText = displayCommand(command, args);
  const child = await runExactProcess(command, args, {
    cwd: invocationCwd,
    capture: options.json === true,
  });
  const recorded = await recordShellResultForSession(
    session.sessionId,
    {
      command: commandText,
      actor: "agent",
      summary: `Run ${path.basename(command)}`,
      result: {
        exitCode: child.code,
        signal: child.signal,
        ...(options.json === true ? {
          stdout: child.stdout,
          stderr: child.stderr,
        } : {}),
      },
    },
    { cwd },
  );
  const checkpoint = await captureSessionCheckpoint(
    session.sessionId,
    {
      actor: "agent",
      summary: `Changes from ${path.basename(command)}`,
      causedByEventId: recorded.event.id,
    },
    { cwd },
  );

  if (child.code !== 0) {
    await updateActiveSession({ state: "stale", pid: null }, { cwd });
    process.exitCode = child.code;
    const result = {
      ok: false,
      exitCode: child.code,
      signal: child.signal,
      checkpointCaptured: checkpoint.appended,
      resumable: true,
      ...(options.json === true ? {
        stdout: child.stdout,
        stderr: child.stderr,
      } : {}),
    };
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`Agent exited with code ${child.code}. The run is preserved.
Resume: recipe run --resume -- <agent command>
Abort:  recipe run --abort`);
    }
    return;
  }

  await assertBaseIsAncestor(session.repo.baseCommit, cwd);
  const headBeforeCommit = await resolveCommit("HEAD", { cwd });
  const dirty = await worktreeStatus(cwd);
  let autoCommitted = false;
  if (dirty && await shouldCreateCommit(options)) {
    await runGit(["add", "-A", "--", "."], { cwd });
    await runGit(
      ["commit", "-m", options.message ?? defaultCommitMessage(
        options.prompt ?? session.instructions.prompts.at(-1) ?? "captured agent changes",
      )],
      {
        cwd,
        env: { RECIPE_RUN_MANAGED: "1" },
      },
    );
    autoCommitted = true;
  }

  if (dirty && !autoCommitted) {
    await updateActiveSession({ state: "awaiting_commit", pid: null }, { cwd });
    process.exitCode = 2;
    const result = {
      ok: false,
      state: "awaiting_commit",
      exitCode: 2,
      commitCreated: false,
      resumable: true,
      command: commandText,
    };
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Captured changes are awaiting your commit. No commit was created.
Review: git diff
Commit: git add -A && git commit
Abort:  recipe run --abort`);
    }
    return;
  }

  const targetCommit = await resolveCommit("HEAD", { cwd });
  if (targetCommit === session.repo.baseCommit && !checkpoint.appended) {
    await clearActiveSession({ cwd });
    throw new Error("The agent completed without creating a commit or changing the working tree.");
  }
  await assertBaseIsAncestor(session.repo.baseCommit, cwd);

  const finalized = await finalizeCaptureSession(
    session.sessionId,
    { targetRef: targetCommit },
    { cwd },
  );
  const gitDir = await resolveGitDir(cwd);
  const published = await publishRecipeRef(targetCommit, {
    cwd,
    outputDir: path.join(gitDir, "recipe-publish"),
    attach: true,
  });
  const result = {
    ok: true,
    sourceAgent: finalized.recipe.metadata.sourceAgent,
    baseCommit: session.repo.baseCommit,
    targetCommit,
    commitCreated: autoCommitted,
    agentCreatedCommit: headBeforeCommit !== session.repo.baseCommit,
    recipePath: finalized.stored.path,
    recipeSha256: finalized.stored.sha256,
    notesRef: published.attachment.notesRef,
    command: commandText,
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Captured and attached Recipe:
  commit: ${targetCommit}
  source: ${result.sourceAgent}
  recipe: ${result.recipePath}
  notes:  ${result.notesRef}`);
}
