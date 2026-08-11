import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { readRecipeBundle } from "../src/core/storage.js";
import { shouldCreateCommit } from "../src/commands/run.js";
import {
  commitFile,
  createTempRepo,
  run,
  runCli,
  runCliResult,
} from "./helpers.js";

async function createAgentFixture(repoDir, { commits = false } = {}) {
  const body = commits
    ? `import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], process.argv[3]);
execFileSync("git", ["add", process.argv[2]]);
execFileSync("git", ["commit", "-m", "agent-authored commit"], { stdio: "ignore" });
`
    : `import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], process.argv[3]);
`;
  await writeFile(path.join(repoDir, "agent.mjs"), body, "utf8");
  await run("git", ["add", "agent.mjs"], repoDir);
  await run("git", ["commit", "-m", "add agent fixture"], repoDir);
}

test("recipe init is local-only and idempotent", async () => {
  const repoDir = await createTempRepo("recipe-init");
  await commitFile(repoDir, "calc.js", "export const calc = () => 0;\n", "base");

  const first = JSON.parse(await runCli(repoDir, ["init", "--json"]));
  const second = JSON.parse(await runCli(repoDir, ["init", "--json"]));

  assert.equal(first.initialized, true);
  assert.equal(first.alreadyInitialized, false);
  assert.equal(second.alreadyInitialized, true);
  assert.equal(second.configPath, first.configPath);
  assert.equal(await run("git", ["status", "--porcelain"], repoDir), "");

  const config = JSON.parse(await readFile(first.configPath, "utf8"));
  assert.deepEqual(config.workflow, { autoCommit: false, attach: true });
  assert.equal(first.hook.managed, true);
  assert.equal(second.hook.alreadyInstalled, true);
});

test("recipe run commits, finalizes, attaches, inspects, and replays without session ids", async () => {
  const repoDir = await createTempRepo("recipe-run");
  await commitFile(repoDir, "calc.js", "export const calc = () => 0;\n", "base");
  const codexFixture = path.join(repoDir, "codex.mjs");
  await writeFile(
    codexFixture,
    `import { writeFileSync } from "node:fs";\nwriteFileSync("calc.js", "export const calc = () => 42;\\n");\n`,
    "utf8",
  );
  await run("git", ["add", "codex.mjs"], repoDir);
  await run("git", ["commit", "-m", "add codex fixture"], repoDir);
  const baseCommit = await run("git", ["rev-parse", "HEAD"], repoDir);
  await runCli(repoDir, ["init"]);

  const output = await runCli(
    repoDir,
    [
      "run",
      "--commit",
      "--prompt",
      "Fix calc so it returns forty two.",
      "--message",
      "fix: return forty two",
      "--source-agent",
      "codex",
      "--",
      process.execPath,
      codexFixture,
    ],
  );

  assert.match(output, /Captured and attached Recipe/);
  assert.doesNotMatch(output, /session/i);
  assert.equal(
    await run("git", ["log", "-1", "--format=%s"], repoDir),
    "fix: return forty two",
  );
  assert.equal(await readFile(path.join(repoDir, "calc.js"), "utf8"), "export const calc = () => 42;\n");
  assert.equal(await run("git", ["status", "--porcelain"], repoDir), "");
  await assert.rejects(() => stat(path.join(repoDir, "outputs")));

  const targetCommit = await run("git", ["rev-parse", "HEAD"], repoDir);
  assert.notEqual(targetCommit, baseCommit);
  const recipe = await readRecipeBundle("HEAD", { cwd: repoDir });
  assert.equal(recipe.repo.baseCommit, baseCommit);
  assert.equal(recipe.repo.targetCommit, targetCommit);
  assert.equal(recipe.metadata.sourceAgent, "codex");
  assert.deepEqual(recipe.instructions.prompts, ["Fix calc so it returns forty two."]);
  assert.deepEqual(
    recipe.events.map((event) => event.type),
    ["prompt", "shell_command", "file_edit_checkpoint"],
  );

  const note = await run(
    "git",
    ["notes", "--ref", "refs/notes/recipe", "show", "HEAD"],
    repoDir,
  );
  assert.match(note, /Recipe-Id:/);
  assert.match(await runCli(repoDir, ["inspect", "HEAD"]), /Recipe /);
  const status = JSON.parse(await runCli(repoDir, ["status", "--json"]));
  assert.equal(status.runState, "idle");
  assert.equal(typeof status.lastAttachedRecipe, "string");

  const replay = JSON.parse(await runCli(repoDir, ["replay", "HEAD", "--json"]));
  assert.equal(replay.status, "exact");
  assert.equal(replay.success, true);
});

test("recipe run commits repository-wide changes when invoked from a subdirectory", async () => {
  const repoDir = await createTempRepo("recipe-run-subdir");
  await mkdir(path.join(repoDir, "packages", "app"), { recursive: true });
  await writeFile(path.join(repoDir, "root.txt"), "before\n", "utf8");
  await writeFile(
    path.join(repoDir, "agent.mjs"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync("../../root.txt", "after\\n");\n`,
    "utf8",
  );
  await run("git", ["add", "."], repoDir);
  await run("git", ["commit", "-m", "base"], repoDir);
  await runCli(repoDir, ["init"]);

  const subdir = path.join(repoDir, "packages", "app");
  await runCli(subdir, [
    "run",
    "--commit",
    "--prompt",
    "Update the repository root file.",
    "--",
    "node",
    "../../agent.mjs",
  ]);

  assert.equal(await readFile(path.join(repoDir, "root.txt"), "utf8"), "after\n");
  assert.equal(await run("git", ["status", "--porcelain"], repoDir), "");
  const replay = JSON.parse(await runCli(repoDir, ["replay", "HEAD", "--json"]));
  assert.equal(replay.status, "exact");
});

test("recipe run reuses an agent-created commit instead of adding another", async () => {
  const repoDir = await createTempRepo("recipe-run-agent-commit");
  await commitFile(repoDir, "calc.js", "export const calc = () => 0;\n", "base");
  await createAgentFixture(repoDir, { commits: true });
  const baseCommit = await run("git", ["rev-parse", "HEAD"], repoDir);
  await runCli(repoDir, ["init"]);

  const result = JSON.parse(await runCli(repoDir, [
    "run",
    "--prompt",
    "Let the agent commit the change.",
    "--source-agent",
    "aider",
    "--json",
    "--",
    "node",
    "agent.mjs",
    "calc.js",
    "export const calc = () => 7;\n",
  ]));

  assert.equal(result.commitCreated, false);
  assert.equal(result.agentCreatedCommit, true);
  assert.equal(
    await run("git", ["rev-list", "--count", `${baseCommit}..HEAD`], repoDir),
    "1",
  );
  assert.equal(await run("git", ["log", "-1", "--format=%s"], repoDir), "agent-authored commit");

  const replay = JSON.parse(await runCli(repoDir, ["replay", "HEAD", "--json"]));
  assert.equal(replay.status, "exact");
  assert.equal(replay.success, true);
});

test("recipe run rejects unrelated changes and preserves failed runs for id-free resume", async () => {
  const dirtyRepo = await createTempRepo("recipe-run-dirty");
  await commitFile(dirtyRepo, "calc.js", "export const calc = () => 0;\n", "base");
  await runCli(dirtyRepo, ["init"]);
  await writeFile(path.join(dirtyRepo, "calc.js"), "export const calc = () => 9;\n", "utf8");

  const rejected = await runCliResult(dirtyRepo, [
    "run",
    "--prompt",
    "Should not run.",
    "--",
    "node",
    "-e",
    "require('fs').writeFileSync('marker', 'ran')",
  ]);
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /clean working tree/);
  await assert.rejects(() => readFile(path.join(dirtyRepo, "marker"), "utf8"));

  const repoDir = await createTempRepo("recipe-run-resume");
  await commitFile(repoDir, "calc.js", "export const calc = () => 0;\n", "base");
  await runCli(repoDir, ["init"]);
  const failed = await runCliResult(repoDir, [
    "run",
    "--prompt",
    "Try the first implementation.",
    "--",
    "node",
    "-e",
    "require('fs').writeFileSync('calc.js', 'export const calc = () => 1;\\n'); process.exit(7)",
  ]);
  assert.equal(failed.code, 7);
  assert.match(failed.stderr, /recipe run --resume/);
  assert.equal(await run("git", ["rev-list", "--count", "HEAD"], repoDir), "1");

  const resumed = await runCli(repoDir, [
    "run",
    "--resume",
    "--commit",
    "--prompt",
    "Correct the implementation.",
    "--message",
    "fix: resumed recipe",
    "--",
    "node",
    "-e",
    "require('fs').writeFileSync('calc.js', 'export const calc = () => 2;\\n')",
  ]);
  assert.match(resumed, /Captured and attached Recipe/);
  assert.doesNotMatch(resumed, /session/i);

  const recipe = await readRecipeBundle("HEAD", { cwd: repoDir });
  assert.deepEqual(recipe.instructions.prompts, [
    "Try the first implementation.",
    "Correct the implementation.",
  ]);
  const replay = JSON.parse(await runCli(repoDir, ["replay", "HEAD", "--json"]));
  assert.equal(replay.status, "exact");
  assert.equal(replay.success, true);
});

test("commit consent is explicit in automation and confirmed interactively", async () => {
  assert.equal(await shouldCreateCommit({ commit: true }, { interactive: false }), true);
  assert.equal(await shouldCreateCommit({ commit: false }, { interactive: true, confirm: async () => true }), false);
  assert.equal(await shouldCreateCommit({}, { interactive: false }), false);
  assert.equal(await shouldCreateCommit({}, { interactive: true, confirm: async () => true }), true);
  assert.equal(await shouldCreateCommit({}, { interactive: true, confirm: async () => false }), false);

  const repoDir = await createTempRepo("recipe-awaiting-commit");
  await commitFile(repoDir, "value.txt", "before\n", "base");
  await runCli(repoDir, ["init"]);
  const before = await run("git", ["rev-parse", "HEAD"], repoDir);
  const result = await runCliResult(repoDir, [
    "run",
    "--prompt",
    "Update without implicit commit.",
    "--json",
    "--",
    "node",
    "-e",
    "require('fs').writeFileSync('value.txt', 'after\\n')",
  ]);
  assert.equal(result.code, 2);
  assert.equal(JSON.parse(result.stdout).state, "awaiting_commit");
  assert.equal(await run("git", ["rev-parse", "HEAD"], repoDir), before);
  assert.equal(await readFile(path.join(repoDir, "value.txt"), "utf8"), "after\n");
  assert.equal(JSON.parse(await runCli(repoDir, ["status", "--json"])).runState, "awaiting_commit");

  await runCli(repoDir, ["run", "--abort"]);
  assert.equal(JSON.parse(await runCli(repoDir, ["status", "--json"])).runState, "idle");
});
