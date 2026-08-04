import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { detectAgents, resolveExecutable } from "../src/core/environment.js";
import { commitFile, createTempRepo, runCli, runCliResult } from "./helpers.js";

test("agent detection is PATH-only and supports Windows PATHEXT", async () => {
  const binDir = await mkdtemp(path.join(os.tmpdir(), "recipe-agents-"));
  for (const command of ["codex", "claude", "aider"]) {
    const filePath = path.join(binDir, command);
    await writeFile(filePath, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(filePath, 0o755);
  }
  const agents = await detectAgents({ env: { PATH: binDir } });
  assert.deepEqual(agents.map((agent) => agent.name), ["codex", "claude-code", "aider"]);

  const windowsBin = path.join(binDir, "windows");
  await mkdir(windowsBin);
  await writeFile(path.join(windowsBin, "codex.CMD"), "@exit /b 0\r\n", "utf8");
  assert.equal(
    await resolveExecutable("codex", {
      platform: "win32",
      env: { PATH: windowsBin, PATHEXT: ".CMD;.EXE" },
    }),
    path.join(windowsBin, "codex.CMD"),
  );
});

test("doctor separates blockers from warnings and status exposes stable run states", async () => {
  const repoDir = await createTempRepo("recipe-diagnostics");
  await commitFile(repoDir, "value.txt", "before\n", "base");

  const beforeInit = await runCliResult(repoDir, ["doctor", "--json"]);
  assert.equal(beforeInit.code, 1);
  const blocked = JSON.parse(beforeInit.stdout);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.checks.find((item) => item.id === "initialized").status, "blocker");

  await runCli(repoDir, ["init"]);
  const ready = JSON.parse(await runCli(repoDir, ["doctor", "--json"]));
  assert.equal(ready.ok, true);
  assert.equal(ready.blockers, 0);
  assert.equal(JSON.parse(await runCli(repoDir, ["status", "--json"])).runState, "idle");

  await runCli(repoDir, ["codex", "start", "--prompt", "Hold this run.", "--json"]);
  assert.equal(JSON.parse(await runCli(repoDir, ["status", "--json"])).runState, "running");
  await runCli(repoDir, ["run", "--abort"]);

  const failed = await runCliResult(repoDir, [
    "run", "--prompt", "Fail safely.", "--", "node", "-e", "process.exit(6)",
  ]);
  assert.equal(failed.code, 6);
  assert.equal(JSON.parse(await runCli(repoDir, ["status", "--json"])).runState, "stale");
});
