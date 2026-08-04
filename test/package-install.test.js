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

async function exec(command, args, cwd) {
  const result = await execFileAsync(command, args, {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
  });
  return result.stdout.trimEnd();
}

test("packed CLI installs with only runtime files and completes the no-session-id workflow", async () => {
  const packDir = await mkdtemp(path.join(os.tmpdir(), "recipe-pack-"));
  const packResult = JSON.parse(await exec(
    "npm",
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
  await exec(
    "npm",
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
  assert.match(await exec(recipeBin, ["--help"], installDir), /recipe run/);

  const repoDir = await createTempRepo("recipe-packed-workflow");
  await commitFile(repoDir, "value.txt", "before\n", "base");
  await run("git", ["config", "--local", "core.hooksPath", ".git/custom-hooks"], repoDir);
  const hookDir = path.join(repoDir, ".git", "custom-hooks");
  const hookPath = path.join(hookDir, "post-commit");
  const originalHook = "#!/bin/sh\n: existing hook\n";
  await mkdir(hookDir);
  await writeFile(hookPath, originalHook, "utf8");
  await chmod(hookPath, 0o755);
  await exec(recipeBin, ["init"], repoDir);
  const runOutput = await exec(recipeBin, [
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
  assert.match(await exec(recipeBin, ["inspect", "HEAD"], repoDir), /fixture-agent/);
  assert.match(await exec(recipeBin, ["replay", "HEAD"], repoDir), /Replay exact/);
  const verification = JSON.parse(await exec(
    recipeBin,
    ["verify", "HEAD", "--replay", "--json"],
    repoDir,
  ));
  assert.equal(verification.ok, true);

  await exec(recipeBin, ["hooks", "uninstall"], repoDir);
  assert.equal(await readFile(hookPath, "utf8"), originalHook);
  assert.equal(
    await run("git", ["config", "--local", "--get", "core.hooksPath"], repoDir),
    ".git/custom-hooks",
  );
  await exec("npm", ["uninstall", "--prefix", installDir, "recipe"], installDir);
  assert.equal(await readFile(hookPath, "utf8"), originalHook);
});
