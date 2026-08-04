#!/usr/bin/env node

import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const recipeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(recipeRoot, "src", "cli.js");

const allDemos = [
  {
    name: "emotion-3386",
    base: "b882bcba85132554992e4bd49e94c95939bbf810",
    target: "2a88c454952318b8efd3e8e95e0e8117f30fc0e4",
    branch: "recipe-demo/3386-babel-8-path-hoist",
    source: process.env.RECIPE_DEMO_EMOTION_SOURCE ?? "https://github.com/emotion-js/emotion.git",
    sparsePaths: ["/.changeset/", "/packages/babel-plugin/"],
  },
  {
    name: "material-ui-41067",
    base: "307ccfd4fac5a9d1c8a98e470ff3e23b6b403c4d",
    target: "ae3853d5c903aaf19a7699fcdbe136e9bd838fb2",
    branch: "recipe-demo/41067-speed-dial-tooltip-placement",
    source: process.env.RECIPE_DEMO_MUI_SOURCE ?? "https://github.com/mui/material-ui.git",
    sparsePaths: [
      "/packages/mui-material/src/SpeedDial/",
      "/packages/mui-material/src/SpeedDialAction/",
    ],
  },
  {
    name: "shadcn-ui-10543",
    base: "bc0705384b51252af26dcc65425b216bf5eb063c",
    target: "50fd7bf22fcce9c9843a8f940d7a59f3d7b36732",
    branch: "recipe-demo/10543-align-base-select-popup",
    source: process.env.RECIPE_DEMO_SHADCN_SOURCE ?? "https://github.com/shadcn-ui/ui.git",
    sparsePaths: ["/apps/v4/registry/", "/apps/v4/styles/", "/apps/v4/public/r/styles/"],
  },
];
const selectedNames = new Set(process.argv.slice(2));
const demos = selectedNames.size
  ? allDemos.filter((demo) => selectedNames.has(demo.name))
  : allDemos;

async function run(command, args, cwd) {
  const result = await execFileAsync(command, args, {
    cwd,
    maxBuffer: 30 * 1024 * 1024,
  });
  return result.stdout.trimEnd();
}

async function tryRun(command, args, cwd) {
  try {
    return { ok: true, stdout: await run(command, args, cwd) };
  } catch (error) {
    return { ok: false, error };
  }
}

async function auditDemo(demo) {
  const demoDir = path.join(recipeRoot, "demos", demo.name);
  const auditRoot = await mkdtemp(path.join(os.tmpdir(), `recipe-audit-${demo.name}-`));
  try {
    const cloneDir = path.join(auditRoot, "repo");
    await mkdir(cloneDir);
    await run("git", ["init"], cloneDir);

  // Seed only the declared base. The target must then arrive from the demo bundle.
    await run("git", ["fetch", "--no-tags", "--depth=1", demo.source, demo.base], cloneDir);
    await run("git", ["fetch", path.join(demoDir, "demo.git.bundle"), `${demo.branch}:refs/heads/${demo.branch}`], cloneDir);
    const notesFetch = await tryRun(
      "git",
      ["fetch", path.join(demoDir, "demo.git.bundle"), "refs/notes/recipe:refs/notes/recipe"],
      cloneDir,
    );
    await run("git", ["sparse-checkout", "set", "--no-cone", ...demo.sparsePaths], cloneDir);
    await run("git", ["switch", demo.branch], cloneDir);

  const actualTarget = await run("git", ["rev-parse", "HEAD"], cloneDir);
  const actualBase = await run("git", ["rev-parse", "HEAD^"], cloneDir);
  if (actualTarget !== demo.target || actualBase !== demo.base) {
    throw new Error(`${demo.name}: reconstructed SHA mismatch`);
  }

  const recipesDir = path.join(cloneDir, ".git", "recipes");
  await mkdir(recipesDir, { recursive: true });
  await copyFile(
    path.join(demoDir, "recipe.json.zst"),
    path.join(recipesDir, `${demo.target}.json.zst`),
  );

  const expectedNote = (await readFile(path.join(demoDir, "recipe-note.txt"), "utf8")).trimEnd();
  let noteSource = "bundle";
  if (!notesFetch.ok) {
    noteSource = "recipe-note.txt";
    const notePath = path.join(auditRoot, "recipe-note.txt");
    await writeFile(notePath, `${expectedNote}\n`, "utf8");
    await run("git", ["config", "user.name", "Recipe Demo Audit"], cloneDir);
    await run("git", ["config", "user.email", "recipe-audit@example.invalid"], cloneDir);
    await run("git", ["notes", "--ref", "refs/notes/recipe", "add", "-F", notePath, "HEAD"], cloneDir);
  }

  const inspect = await run(process.execPath, [cliPath, "inspect", "HEAD", "--timeline"], cloneDir);
  const replay = await run(process.execPath, [cliPath, "replay", "HEAD"], cloneDir);
  const bundledNote = await run("git", ["notes", "--ref", "refs/notes/recipe", "show", "HEAD"], cloneDir);
  if (bundledNote !== expectedNote) {
    throw new Error(`${demo.name}: bundled Recipe note does not match recipe-note.txt`);
  }

  // Recreate local-only publish files referenced by the note before the full audit.
  await run(
    process.execPath,
    [cliPath, "publish", "HEAD", "--output", ".git/recipe-publish"],
    cloneDir,
  );
  const verifyText = await run(process.execPath, [cliPath, "verify", "HEAD", "--replay", "--json"], cloneDir);
  const verify = JSON.parse(verifyText);
  const status = await run("git", ["status", "--porcelain"], cloneDir);

  if (!/Replay exact/.test(replay) || !verify.ok || verify.replay?.status !== "exact" || status) {
    throw new Error(`${demo.name}: replay, verification, or clean-tree gate failed ${JSON.stringify({
      replayHeadline: replay.split("\n")[0],
      verifyOk: verify.ok,
      verifyReplay: verify.replay?.status,
      status,
    })}`);
  }

    const result = {
    name: demo.name,
    base: actualBase,
    target: actualTarget,
    branch: demo.branch,
    replay: "exact",
    verifyOk: true,
    failures: verify.failureCount,
    warnings: verify.warningCount,
    clean: true,
    noteSource,
    };
    return result;
  } finally {
    await rm(auditRoot, { recursive: true, force: true });
  }
}

const results = [];
for (const demo of demos) {
  results.push(await auditDemo(demo));
}

await writeFile(
  path.join(recipeRoot, "demos", "audit.json"),
  `${JSON.stringify({ auditedAt: new Date().toISOString(), results }, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify(results, null, 2));
