import { exec, execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { sha256Hex } from "./utils.js";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

export async function runGit(args, { cwd, env } = {}) {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      maxBuffer: 20 * 1024 * 1024,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      code: 0,
    };
  } catch (error) {
    const message = error.stderr || error.message;
    throw new Error(message.trim());
  }
}

export async function readCommitMessage(ref, { cwd } = {}) {
  const result = await runGit(["log", "-1", "--format=%B", ref], { cwd });
  return result.stdout.replace(/\s+$/, "");
}

export async function runShell(command, { cwd } = {}) {
  try {
    const result = await execAsync(command, {
      cwd,
      maxBuffer: 20 * 1024 * 1024,
      shell: true,
    });
    return {
      code: 0,
      stdout: result.stdout.trimEnd(),
      stderr: result.stderr.trimEnd(),
    };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: (error.stdout ?? "").trimEnd(),
      stderr: (error.stderr ?? error.message).trimEnd(),
    };
  }
}

export async function runShellStreaming(
  command,
  {
    cwd,
    onStdout,
    onStderr,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      onStdout?.(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      onStderr?.(text);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
      });
    });
  });
}

export async function resolveRepoRoot(cwd) {
  const result = await runGit(["rev-parse", "--show-toplevel"], { cwd });
  return result.stdout.trim();
}

export async function resolveGitDir(cwd) {
  const repoRoot = await resolveRepoRoot(cwd);
  const result = await runGit(["rev-parse", "--git-dir"], { cwd });
  const gitDir = result.stdout.trim();
  return path.isAbsolute(gitDir)
    ? gitDir
    : path.resolve(repoRoot, gitDir);
}

export async function resolveCommit(ref, { cwd } = {}) {
  const result = await runGit(["rev-parse", ref], { cwd });
  return result.stdout.trim();
}

export async function resolveTree(ref, { cwd } = {}) {
  const result = await runGit(["rev-parse", `${ref}^{tree}`], { cwd });
  return result.stdout.trim();
}

export async function diffRefs(base, target, { cwd } = {}) {
  const result = await runGit(["diff", "--binary", base, target], { cwd });
  return result.stdout;
}

export async function getDiff(base, target, { cwd } = {}) {
  return diffRefs(base, target, { cwd });
}

export async function getRemoteFingerprint(cwd) {
  try {
    const origin = await runGit(["remote", "get-url", "origin"], { cwd });
    const raw = origin.stdout.trim();
    return raw ? sha256Hex(raw) : null;
  } catch {
    try {
      const remotes = await runGit(["remote", "-v"], { cwd });
      const raw = remotes.stdout.trim();
      return raw ? sha256Hex(raw) : null;
    } catch {
      return null;
    }
  }
}

export async function writeGitNote(
  notesRef,
  targetCommit,
  text,
  { cwd } = {},
) {
  const noteDir = await mkdtemp(path.join(os.tmpdir(), "recipe-note-"));
  const notePath = path.join(noteDir, "note.txt");
  await writeFile(notePath, text, "utf8");

  try {
    await runGit(
      ["notes", "--ref", notesRef, "add", "-f", "-F", notePath, targetCommit],
      { cwd },
    );
  } finally {
    await rm(noteDir, { recursive: true, force: true });
  }
}

export async function readGitNote(
  notesRef,
  targetCommit,
  { cwd } = {},
) {
  try {
    const result = await runGit(
      ["notes", "--ref", notesRef, "show", targetCommit],
      { cwd },
    );
    return result.stdout.replace(/\s+$/, "");
  } catch {
    return null;
  }
}

export async function snapshotWorktreeTree(baseRef, { cwd } = {}) {
  const repoRoot = await resolveRepoRoot(cwd);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "recipe-index-"));
  const tempIndex = path.join(tempDir, "index");
  const env = {
    GIT_INDEX_FILE: tempIndex,
  };

  try {
    await runGit(["read-tree", baseRef], { cwd: repoRoot, env });
    await runGit(["add", "-A", "--", "."], { cwd: repoRoot, env });
    const tree = await runGit(["write-tree"], { cwd: repoRoot, env });
    return tree.stdout.trim();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function withTempWorktree(
  baseCommit,
  { cwd, keep = false, sparsePaths = [] } = {},
  fn,
) {
  const repoRoot = await resolveRepoRoot(cwd);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "recipe-worktree-"));
  let ready = false;

  try {
    if (sparsePaths.length) {
      await runGit(
        ["worktree", "add", "--detach", "--no-checkout", tempDir, baseCommit],
        { cwd: repoRoot },
      );
      await runGit(["sparse-checkout", "set", "--no-cone", ...sparsePaths], {
        cwd: tempDir,
      });
      await runGit(["checkout", "--detach", baseCommit], { cwd: tempDir });
    } else {
      await runGit(["worktree", "add", "--detach", tempDir, baseCommit], {
        cwd: repoRoot,
      });
    }
    ready = true;
    return await fn(tempDir);
  } finally {
    if (!keep || !ready) {
      try {
        await runGit(["worktree", "remove", "--force", tempDir], {
          cwd: repoRoot,
        });
      } catch {
        // The worktree may not have been registered if setup failed early.
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}
