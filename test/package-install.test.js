import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { commitFile, createTempRepo, run } from "./helpers.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const npmCliPath = process.env.npm_execpath;

async function exec(command, args, cwd) {
  const result = await execFileAsync(command, args, {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
  });
  return result.stdout.trimEnd();
}

async function execNpm(args, cwd) {
  if (npmCliPath) {
    return exec(process.execPath, [npmCliPath, ...args], cwd);
  }
  return exec("npm", args, cwd);
}

test("packed CLI installs with only runtime files and completes the no-session-id workflow", async () => {
  const packDir = await mkdtemp(path.join(os.tmpdir(), "recipe-pack-"));
  const packResult = JSON.parse(await execNpm(
    [
      "pack",
      "--pack-destination",
      packDir,
      "--json",
      "--cache",
      path.join(packDir, "cache"),
    ],
    projectRoot,
  ));
  const packed = packResult[0];
  assert.equal(
    packed.files.every((file) => (
      file.path === "package.json"
      || file.path === "README.md"
      || file.path === "LICENSE"
      || file.path.startsWith("src/")
    )),
    true,
  );

  const installDir = await mkdtemp(path.join(os.tmpdir(), "recipe-install-"));
  const tarballPath = path.join(packDir, packed.filename);
  await execNpm(
    [
      "install",
      "--prefix",
      installDir,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--cache",
      path.join(installDir, "cache"),
      tarballPath,
    ],
    installDir,
  );
  const recipeBin = path.join(
    installDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "recipe.cmd" : "recipe",
  );
  const installedCli = path.join(installDir, "node_modules", "recipe", "src", "cli.js");
  const execRecipe = (args, cwd) => exec(process.execPath, [installedCli, ...args], cwd);
  assert.match(await execRecipe(["--help"], installDir), /recipe run/);
  assert.equal(await readFile(recipeBin, "utf8").then(() => true), true);

  const repoDir = await createTempRepo("recipe-packed-workflow");
  await commitFile(repoDir, "value.txt", "before\n", "base");
  await run("git", ["config", "--local", "core.hooksPath", ".git/custom-hooks"], repoDir);
  const hookDir = path.join(repoDir, ".git", "custom-hooks");
  const hookPath = path.join(hookDir, "post-commit");
  const originalHook = "#!/bin/sh\n: existing hook\n";
  await mkdir(hookDir);
  await writeFile(hookPath, originalHook, "utf8");
  await chmod(hookPath, 0o755);
  await execRecipe(["init"], repoDir);
  const runOutput = await execRecipe([
    "run",
    "--commit",
    "--prompt",
    "Update the value.",
    "--source-agent",
    "fixture-agent",
    "--",
    process.execPath,
    "-e",
    "require('fs').writeFileSync('value.txt', 'after\\n')",
  ], repoDir);

  assert.match(runOutput, /Captured and attached Recipe/);
  assert.doesNotMatch(runOutput, /session/i);
  assert.equal(await readFile(path.join(repoDir, "value.txt"), "utf8"), "after\n");
  assert.match(await execRecipe(["inspect", "HEAD"], repoDir), /fixture-agent/);
  assert.match(await execRecipe(["replay", "HEAD"], repoDir), /Replay exact/);
  const verification = JSON.parse(await execRecipe(
    ["verify", "HEAD", "--replay", "--json"],
    repoDir,
  ));
  assert.equal(verification.ok, true);

  await execRecipe(["hooks", "uninstall"], repoDir);
  assert.equal(await readFile(hookPath, "utf8"), originalHook);
  assert.equal(
    await run("git", ["config", "--local", "--get", "core.hooksPath"], repoDir),
    ".git/custom-hooks",
  );
  await execNpm(["uninstall", "--prefix", installDir, "recipe"], installDir);
  assert.equal(await readFile(hookPath, "utf8"), originalHook);
});
