import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { readRecipeBundle } from "../src/core/storage.js";
import { createTempRepo, commitFile, run, runCli, runCliResult } from "./helpers.js";

test("managed hook composes with custom hooksPath and restores existing content exactly", async () => {
  const repoDir = await createTempRepo("recipe-hook-compose");
  await commitFile(repoDir, "value.txt", "before\n", "base");
  await run("git", ["config", "--local", "core.hooksPath", "custom-hooks"], repoDir);
  const hooksDir = path.join(repoDir, "custom-hooks");
  const hookPath = path.join(hooksDir, "post-commit");
  const markerPath = path.join(repoDir, ".git", "existing-hook-ran");
  await mkdir(hooksDir, { recursive: true });
  const original = `#!/bin/sh\nprintf existing >> '${markerPath}'\n`;
  await writeFile(hookPath, original, "utf8");
  await chmod(hookPath, 0o755);

  const first = JSON.parse(await runCli(repoDir, ["hooks", "install", "--json"]));
  const installedContents = await readFile(hookPath, "utf8");
  const second = JSON.parse(await runCli(repoDir, ["hooks", "install", "--json"]));
  assert.match(first.path, /custom-hooks[/\\]post-commit$/);
  assert.equal(second.alreadyInstalled, true);
  assert.equal(await readFile(hookPath, "utf8"), installedContents);
  assert.equal(await run("git", ["config", "--local", "--get", "core.hooksPath"], repoDir), "custom-hooks");

  await writeFile(hookPath, `${installedContents}printf external >> '${markerPath}'\n`, "utf8");
  await runCli(repoDir, ["hooks", "uninstall"]);
  assert.equal(await readFile(hookPath, "utf8"), `${original}printf external >> '${markerPath}'\n`);
  assert.equal(await run("git", ["config", "--local", "--get", "core.hooksPath"], repoDir), "custom-hooks");
});

test("hook uninstall restores a no-newline hook and its original mode", async () => {
  const repoDir = await createTempRepo("recipe-hook-mode");
  await commitFile(repoDir, "value.txt", "before\n", "base");
  const hookPath = path.join(repoDir, ".git", "hooks", "post-commit");
  await writeFile(hookPath, "#!/bin/sh", "utf8");
  await chmod(hookPath, 0o644);
  await runCli(repoDir, ["hooks", "install"]);
  assert.notEqual((await stat(hookPath)).mode & 0o111, 0);
  await runCli(repoDir, ["hooks", "uninstall"]);
  assert.equal(await readFile(hookPath, "utf8"), "#!/bin/sh");
  assert.equal((await stat(hookPath)).mode & 0o777, 0o644);
});

test("installed post-commit hook preserves existing behavior and attaches an active session", async () => {
  const repoDir = await createTempRepo("recipe-hooks");
  await commitFile(repoDir, "calc.js", "module.exports = { calc: () => 0 };\n", "base");
  const hookPath = path.join(repoDir, ".git", "hooks", "post-commit");
  const markerPath = path.join(repoDir, ".git", "existing-hook-ran");
  const original = "#!/bin/sh\nprintf x >> .git/existing-hook-ran\n";
  await writeFile(hookPath, original, "utf8");
  await chmod(hookPath, 0o755);
  await commitFile(repoDir, "before-install.txt", "before install\n", "before hook install");
  assert.equal(await readFile(markerPath, "utf8"), "x");
  await runCli(repoDir, ["init"]);

  const started = JSON.parse(await runCli(repoDir, [
    "codex", "start", "--prompt", "Change calc to return 1.", "--json",
  ]));
  await runCli(repoDir, [
    "codex", "step", "--session", started.sessionId,
    "--command", `node -e "require('fs').writeFileSync('calc.js', 'module.exports = { calc: () => 1 };\\n')"`,
    "--summary", "Update calc implementation", "--json",
  ]);

  await run("git", ["add", "calc.js"], repoDir);
  await run("git", ["commit", "-m", "target"], repoDir);
  assert.equal(await readFile(markerPath, "utf8"), "xx");
  const recipe = await readRecipeBundle("HEAD", { cwd: repoDir });
  assert.equal(recipe.metadata.sourceAgent, "codex");
  assert.match(await run("git", ["notes", "--ref", "refs/notes/recipe", "show", "HEAD"], repoDir), /Recipe-Id:/);

  await runCli(repoDir, ["hooks", "uninstall"]);
  assert.equal(await readFile(hookPath, "utf8"), original);
  await commitFile(repoDir, "later.txt", "later\n", "later");
  assert.equal(await readFile(markerPath, "utf8"), "xxx");
});

test("unsupported hooks are never modified and doctor gives a manual-chain fix", async () => {
  const repoDir = await createTempRepo("recipe-hook-unsupported");
  await commitFile(repoDir, "value.txt", "value\n", "base");
  const hookPath = path.join(repoDir, ".git", "hooks", "post-commit");
  const original = "#!/usr/bin/env python3\nprint('existing')\n";
  await writeFile(hookPath, original, "utf8");
  await chmod(hookPath, 0o755);

  const install = await runCliResult(repoDir, ["hooks", "install"]);
  assert.equal(install.code, 1);
  assert.match(install.stderr, /left it untouched/);
  assert.equal(await readFile(hookPath, "utf8"), original);

  const initialized = JSON.parse(await runCli(repoDir, ["init", "--json"]));
  assert.match(initialized.hook.warning, /chain/);
  assert.equal(await readFile(hookPath, "utf8"), original);
  const doctor = JSON.parse(await runCli(repoDir, ["doctor", "--json"]));
  const hookCheck = doctor.checks.find((item) => item.id === "post-commit-hook");
  assert.equal(hookCheck.status, "warning");
  assert.match(hookCheck.fix, /run-post-commit/);
});
