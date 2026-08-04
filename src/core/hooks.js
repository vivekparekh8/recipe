import { chmod, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveGitDir, resolveRepoRoot, runGit } from "./git.js";
import { ensureDir, pathExists, readJsonFile, writeJsonFile } from "./utils.js";

export const HOOK_BLOCK_START = "# >>> recipe managed post-commit v1 >>>";
export const HOOK_BLOCK_END = "# <<< recipe managed post-commit v1 <<<";

function quoteShell(value) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function managedBlock(cliPath) {
  return `${HOOK_BLOCK_START}\nif [ "\${RECIPE_RUN_MANAGED:-}" != "1" ]; then\n  node ${quoteShell(cliPath)} hooks run-post-commit --cwd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" >/dev/null 2>&1 || :\nfi\n${HOOK_BLOCK_END}\n`;
}

function splitManagedBlock(contents) {
  const start = contents.indexOf(HOOK_BLOCK_START);
  const endMarker = contents.indexOf(HOOK_BLOCK_END, start);
  if (start < 0 || endMarker < 0) {
    return null;
  }
  let end = endMarker + HOOK_BLOCK_END.length;
  if (contents[end] === "\r" && contents[end + 1] === "\n") {
    end += 2;
  } else if (contents[end] === "\n") {
    end += 1;
  }
  return { before: contents.slice(0, start), after: contents.slice(end) };
}

function shellHook(contents) {
  if (contents.includes("\0")) {
    return false;
  }
  const firstLine = contents.split(/\r?\n/, 1)[0];
  return /^#!.*(?:\/|\benv\s+)(?:ba|da|z)?sh(?:\s|$)/.test(firstLine);
}

async function hookStatePath(cwd) {
  return path.join(await resolveGitDir(cwd), "recipe", "hook-state.json");
}

export async function resolvePostCommitHook(cwd) {
  const repoRoot = await resolveRepoRoot(cwd);
  const result = await runGit(["rev-parse", "--git-path", "hooks/post-commit"], {
    cwd: repoRoot,
  });
  const rawPath = result.stdout.trim();
  return {
    repoRoot,
    path: path.isAbsolute(rawPath) ? rawPath : path.resolve(repoRoot, rawPath),
  };
}

export async function inspectRecipeHook(cwd) {
  const resolved = await resolvePostCommitHook(cwd);
  if (!await pathExists(resolved.path)) {
    return { ...resolved, exists: false, managed: false, compatible: true };
  }
  const contents = await readFile(resolved.path, "utf8").catch(() => null);
  if (contents === null) {
    return { ...resolved, exists: true, managed: false, compatible: false };
  }
  const managed = Boolean(splitManagedBlock(contents));
  return {
    ...resolved,
    exists: true,
    managed,
    compatible: managed || shellHook(contents),
  };
}

export async function installRecipeHook(cwd, cliPath) {
  const hook = await inspectRecipeHook(cwd);
  const statePath = await hookStatePath(cwd);
  if (hook.managed) {
    return { ...hook, installed: false, alreadyInstalled: true };
  }
  if (!hook.compatible) {
    throw new Error(
      `Existing post-commit hook is not a supported shell script: ${hook.path}. Recipe left it untouched; chain "recipe hooks run-post-commit" manually.`,
    );
  }

  let contents = "#!/bin/sh\n";
  let mode = 0o755;
  if (hook.exists) {
    contents = await readFile(hook.path, "utf8");
    mode = (await stat(hook.path)).mode & 0o777;
  }
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const firstBreak = contents.indexOf(newline);
  const insertAt = firstBreak < 0 ? contents.length : firstBreak + newline.length;
  const block = managedBlock(cliPath).replaceAll("\n", newline);
  const separator = firstBreak < 0 ? newline : "";
  const updated = `${contents.slice(0, insertAt)}${separator}${block}${contents.slice(insertAt)}`;

  await ensureDir(path.dirname(hook.path));
  await writeFile(hook.path, updated, "utf8");
  await chmod(hook.path, mode | 0o100);
  await ensureDir(path.dirname(statePath));
  await writeJsonFile(statePath, {
    version: 1,
    path: hook.path,
    created: !hook.exists,
    originalMode: hook.exists ? mode : null,
    addedSeparator: firstBreak < 0,
  });
  return { ...hook, managed: true, installed: true, alreadyInstalled: false };
}

export async function uninstallRecipeHook(cwd) {
  const hook = await inspectRecipeHook(cwd);
  if (!hook.exists || !hook.managed) {
    return { ...hook, removed: false };
  }
  const contents = await readFile(hook.path, "utf8");
  const parts = splitManagedBlock(contents);
  const statePath = await hookStatePath(cwd);
  const state = await pathExists(statePath) ? await readJsonFile(statePath) : null;
  let before = parts.before;
  if (state?.addedSeparator) {
    before = before.endsWith("\r\n") ? before.slice(0, -2) : before.slice(0, -1);
  }
  const restored = `${before}${parts.after}`;
  const createdShell = state?.created === true && /^#!\/bin\/sh\r?\n?$/.test(restored);
  if (createdShell) {
    await rm(hook.path, { force: true });
  } else {
    await writeFile(hook.path, restored, "utf8");
    if (Number.isInteger(state?.originalMode)) {
      await chmod(hook.path, state.originalMode);
    }
  }
  await rm(statePath, { force: true });
  return { ...hook, managed: false, removed: true, fileRemoved: createdShell };
}
