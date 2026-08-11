import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { addGitHubCommentMarker } from "../src/core/github.js";
import { buildReviewComment } from "../src/core/recipe.js";
import { describeResolvedRecipeRef, resolveRecipeRefInput } from "../src/core/refs.js";
import { readRecipeBundle } from "../src/core/storage.js";
import { resolveRecipeRefFromPullRequest } from "../src/core/github.js";
import { replayRecipe } from "../src/core/replay.js";
import { createTempRepo, commitFile, diff, run, runCli } from "./helpers.js";

async function installFakeGh() {
  const fakeDir = await mkdtemp(path.join(os.tmpdir(), "recipe-fake-gh-"));
  const scriptPath = path.join(fakeDir, "gh");
  const statePath = path.join(fakeDir, "state.json");

  await writeFile(
    statePath,
    `${JSON.stringify({ comments: [], nextId: 1, calls: [], releases: {}, pulls: {} }, null, 2)}\n`,
    "utf8",
  );

  await writeFile(
    scriptPath,
    `#!/usr/bin/env node
const fs = require("node:fs");

const statePath = process.env.RECIPE_FAKE_GH_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
state.calls.push(args);
const path = require("node:path");

function save() {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\\n", "utf8");
}

function flagValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

function writeJson(value) {
  process.stdout.write(JSON.stringify(value));
}

if (args[0] === "repo" && args[1] === "view") {
  writeJson({ owner: { login: "vivekparekh8" }, name: "recipe" });
  save();
  process.exit(0);
}

if (args[0] === "api" && args[1] === "user") {
  writeJson({ login: "vivekparekh8" });
  save();
  process.exit(0);
}

if (args[0] === "api") {
  const endpoint = args[1];
  const method = flagValue("--method") || "GET";
  const inputPath = flagValue("--input");
  const payload = inputPath ? JSON.parse(fs.readFileSync(inputPath, "utf8")) : null;

  const issueCommentsMatch = endpoint.match(/^repos\\/vivekparekh8\\/recipe\\/issues\\/(\\d+)\\/comments$/);
  const commentMatch = endpoint.match(/^repos\\/vivekparekh8\\/recipe\\/issues\\/comments\\/(\\d+)$/);
  const releaseTagMatch = endpoint.match(/^repos\\/vivekparekh8\\/recipe\\/releases\\/tags\\/(.+)$/);
  const pullMatch = endpoint.match(/^repos\\/vivekparekh8\\/recipe\\/pulls\\/(\\d+)$/);

  if (method === "GET" && issueCommentsMatch) {
    writeJson(state.comments);
    save();
    process.exit(0);
  }

  if (method === "POST" && issueCommentsMatch) {
    const comment = {
      id: state.nextId++,
      user: { login: "vivekparekh8" },
      body: payload.body,
    };
    state.comments.push(comment);
    writeJson(comment);
    save();
    process.exit(0);
  }

  if (method === "PATCH" && commentMatch) {
    const id = Number(commentMatch[1]);
    const comment = state.comments.find((entry) => entry.id === id);
    if (!comment) {
      process.stderr.write("missing comment");
      process.exit(1);
    }
    comment.body = payload.body;
    writeJson(comment);
    save();
    process.exit(0);
  }

  if (method === "GET" && releaseTagMatch) {
    const tag = releaseTagMatch[1];
    const release = state.releases[tag];
    if (!release) {
      process.stderr.write("404 not found");
      save();
      process.exit(1);
    }
    writeJson(release);
    save();
    process.exit(0);
  }

  if (method === "GET" && pullMatch) {
    const pull = state.pulls[pullMatch[1]];
    if (!pull) {
      process.stderr.write("404 not found");
      save();
      process.exit(1);
    }
    writeJson(pull);
    save();
    process.exit(0);
  }
}

if (args[0] === "release" && args[1] === "create") {
  const tag = args[2];
  const title = flagValue("--title");
  const notes = flagValue("--notes");
  const target = flagValue("--target");
  state.releases[tag] = {
    tag_name: tag,
    html_url: "https://github.com/vivekparekh8/recipe/releases/tag/" + tag,
    title,
    body: notes,
    target_commitish: target,
    assets: state.releases[tag]?.assets || [],
  };
  writeJson(state.releases[tag]);
  save();
  process.exit(0);
}

if (args[0] === "release" && args[1] === "upload") {
  const tag = args[2];
  const release = state.releases[tag];
  if (!release) {
    process.stderr.write("missing release");
    save();
    process.exit(1);
  }

  const files = args.slice(3).filter((value) => value !== "--clobber");
  for (const file of files) {
    const name = path.basename(file);
    const asset = {
      name,
      browser_download_url: "https://github.com/vivekparekh8/recipe/releases/download/" + tag + "/" + name,
    };
    release.assets = release.assets.filter((entry) => entry.name !== name);
    release.assets.push(asset);
  }

  writeJson(release);
  save();
  process.exit(0);
}

process.stderr.write("unsupported gh invocation: " + args.join(" "));
save();
process.exit(1);
`,
    "utf8",
  );
  await chmod(scriptPath, 0o755);

  return {
    fakeDir,
    scriptPath,
    statePath,
  };
}

test("github sync-pr upserts one sticky recipe comment through gh", async () => {
  const repoDir = await createTempRepo("recipe-github-sync");
  const baseCommit = await commitFile(
    repoDir,
    "hello.js",
    "module.exports = { value: 1 };\n",
    "base",
  );
  const targetCommit = await commitFile(
    repoDir,
    "hello.js",
    "module.exports = { value: 2 };\n",
    "target",
  );
  const patch = await diff(repoDir, baseCommit, targetCommit);

  const draftPath = path.join(repoDir, "draft.json");
  await writeFile(
    draftPath,
    `${JSON.stringify({
      metadata: { sourceAgent: "codex", adapterVersion: "0.1.0" },
      repo: { baseCommit, targetCommit },
      instructions: { prompts: ["Update exported value."] },
      events: [
        {
          id: "evt-prompt",
          type: "prompt",
          actor: "user",
          summary: "Update exported value.",
          inputs: { prompt: "Update exported value." },
        },
        {
          id: "evt-shell",
          type: "shell_command",
          actor: "agent",
          summary: "Apply hello.js change",
          command: "codex apply hello change",
        },
        {
          id: "evt-checkpoint",
          type: "file_edit_checkpoint",
          actor: "agent",
          summary: "Capture hello.js change",
          patch,
          causedByEventId: "evt-shell",
        },
        {
          id: "evt-test",
          type: "test_run",
          actor: "agent",
          summary: "Replay sanity check",
          command: 'node -e "process.exit(0)"',
          result: { exitCode: 0 },
        },
      ],
      outputs: {},
      privacy: {},
    }, null, 2)}\n`,
    "utf8",
  );

  await runCli(repoDir, ["capture", "--input", draftPath]);
  const fakeGh = await installFakeGh();
  const env = {
    PATH: `${fakeGh.fakeDir}${path.delimiter}${process.env.PATH}`,
    RECIPE_GH_EXECUTABLE: process.execPath,
    RECIPE_GH_SCRIPT: fakeGh.scriptPath,
    RECIPE_FAKE_GH_STATE: fakeGh.statePath,
  };
  const stateBefore = JSON.parse(await readFile(fakeGh.statePath, "utf8"));
  stateBefore.pulls["123"] = {
    number: 123,
    head: {
      sha: targetCommit,
      ref: "feature/recipe",
    },
  };
  await writeFile(fakeGh.statePath, `${JSON.stringify(stateBefore, null, 2)}\n`, "utf8");

  const firstSync = JSON.parse(
    await runCli(repoDir, [
      "github",
      "sync-pr",
      "HEAD",
      "--pr",
      "123",
      "--replay",
      "--json",
    ], {
      env,
    }),
  );

  assert.equal(firstSync.action, "created");
  assert.equal(firstSync.repo, "vivekparekh8/recipe");
  assert.equal(firstSync.commentId, 1);

  const secondSync = JSON.parse(
    await runCli(repoDir, [
      "github",
      "sync-pr",
      "HEAD",
      "--pr",
      "123",
      "--replay",
      "--json",
    ], {
      env,
    }),
  );

  assert.equal(secondSync.action, "updated");
  assert.equal(secondSync.commentId, 1);

  const state = JSON.parse(await readFile(fakeGh.statePath, "utf8"));
  assert.equal(state.comments.length, 1);
  assert.match(state.comments[0].body, /<!-- recipe-comment:/);
  assert.match(state.comments[0].body, /## recipe for/);
  assert.match(state.comments[0].body, /- verification: pass/);
  assert.match(state.comments[0].body, new RegExp(`recipe verify ${targetCommit} --replay`));
});

test("github sync-pr can publish the structured recipe bundle to a GitHub release asset bucket", async () => {
  const repoDir = await createTempRepo("recipe-github-release");
  const baseCommit = await commitFile(
    repoDir,
    "hello.js",
    "module.exports = { value: 1 };\n",
    "base",
  );
  const targetCommit = await commitFile(
    repoDir,
    "hello.js",
    "module.exports = { value: 2 };\n",
    "target",
  );
  const patch = await diff(repoDir, baseCommit, targetCommit);

  const draftPath = path.join(repoDir, "draft.json");
  await writeFile(
    draftPath,
    `${JSON.stringify({
      metadata: { sourceAgent: "codex", adapterVersion: "0.1.0" },
      repo: { baseCommit, targetCommit },
      instructions: { prompts: ["Update exported value."] },
      events: [
        {
          id: "evt-prompt",
          type: "prompt",
          actor: "user",
          summary: "Update exported value.",
          inputs: { prompt: "Update exported value." },
        },
        {
          id: "evt-shell",
          type: "shell_command",
          actor: "agent",
          summary: "Apply hello.js change",
          command: "codex apply hello change",
        },
        {
          id: "evt-checkpoint",
          type: "file_edit_checkpoint",
          actor: "agent",
          summary: "Capture hello.js change",
          patch,
          causedByEventId: "evt-shell",
        },
      ],
      outputs: {},
      privacy: {},
    }, null, 2)}\n`,
    "utf8",
  );

  await runCli(repoDir, ["capture", "--input", draftPath]);
  const fakeGh = await installFakeGh();
  const env = {
    PATH: `${fakeGh.fakeDir}${path.delimiter}${process.env.PATH}`,
    RECIPE_GH_EXECUTABLE: process.execPath,
    RECIPE_GH_SCRIPT: fakeGh.scriptPath,
    RECIPE_FAKE_GH_STATE: fakeGh.statePath,
  };

  const synced = JSON.parse(
    await runCli(repoDir, [
      "github",
      "sync-pr",
      "HEAD",
      "--pr",
      "123",
      "--release-tag",
      "recipe-artifacts",
      "--json",
    ], {
      env,
    }),
  );

  assert.equal(synced.remoteArtifacts.releaseTag, "recipe-artifacts");
  assert.match(synced.remoteArtifacts.releaseUrl, /releases\/tag\/recipe-artifacts/);
  assert.match(synced.remoteArtifacts.artifactUrl, /releases\/download\/recipe-artifacts/);
  assert.match(synced.remoteArtifacts.manifestUrl, /releases\/download\/recipe-artifacts/);

  const note = await run(
    "git",
    ["notes", "--ref", "refs/notes/recipe", "show", "HEAD"],
    repoDir,
  );
  assert.match(note, /Recipe-Artifact-Url: https:\/\/github\.com\/vivekparekh8\/recipe\/releases\/download\/recipe-artifacts\//);
  assert.match(note, /Recipe-Release-Tag: recipe-artifacts/);

  const manifest = JSON.parse(await readFile(synced.manifestPath, "utf8"));
  assert.equal(manifest.remoteArtifacts.releaseTag, "recipe-artifacts");
  assert.equal(manifest.commands.inspectRemote, `recipe inspect ${synced.remoteArtifacts.artifactUrl}`);

  const state = JSON.parse(await readFile(fakeGh.statePath, "utf8"));
  assert.match(state.comments[0].body, /<!-- recipe-meta:/);
  assert.match(state.comments[0].body, /### Download/);
  assert.match(state.comments[0].body, /- bundle: https:\/\/github\.com\/vivekparekh8\/recipe\/releases\/download\/recipe-artifacts\//);
  assert.match(state.comments[0].body, new RegExp(`recipe inspect ${synced.remoteArtifacts.artifactUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.ok(state.releases["recipe-artifacts"]);
  assert.ok(state.releases["recipe-artifacts"].assets.some((asset) => asset.name.endsWith(".recipe.json.zst")));
});

test("inspect/verify/replay can resolve a PR ref through the synced recipe comment artifact URL", async () => {
  const repoDir = await createTempRepo("recipe-pr-resolve-remote");
  const baseCommit = await commitFile(
    repoDir,
    "hello.js",
    "module.exports = { value: 1 };\n",
    "base",
  );
  const targetCommit = await commitFile(
    repoDir,
    "hello.js",
    "module.exports = { value: 2 };\n",
    "target",
  );
  const patch = await diff(repoDir, baseCommit, targetCommit);

  const draftPath = path.join(repoDir, "draft.json");
  await writeFile(
    draftPath,
    `${JSON.stringify({
      metadata: { sourceAgent: "codex", adapterVersion: "0.1.0" },
      repo: { baseCommit, targetCommit },
      instructions: { prompts: ["Update exported value."] },
      events: [
        {
          type: "prompt",
          actor: "user",
          summary: "Update exported value.",
          inputs: { prompt: "Update exported value." },
        },
        {
          type: "shell_command",
          actor: "agent",
          summary: "Apply hello.js change",
          command: "codex apply hello change",
        },
        {
          type: "file_edit_checkpoint",
          actor: "agent",
          summary: "Capture hello.js change",
          patch,
        },
      ],
      outputs: {},
      privacy: {},
    }, null, 2)}\n`,
    "utf8",
  );

  await runCli(repoDir, ["capture", "--input", draftPath]);
  const fakeGh = await installFakeGh();
  const env = {
    PATH: `${fakeGh.fakeDir}${path.delimiter}${process.env.PATH}`,
    RECIPE_GH_EXECUTABLE: process.execPath,
    RECIPE_GH_SCRIPT: fakeGh.scriptPath,
    RECIPE_FAKE_GH_STATE: fakeGh.statePath,
  };
  const initialState = JSON.parse(await readFile(fakeGh.statePath, "utf8"));
  initialState.pulls["123"] = {
    number: 123,
    head: {
      sha: targetCommit,
      ref: "feature/recipe",
    },
  };
  await writeFile(fakeGh.statePath, `${JSON.stringify(initialState, null, 2)}\n`, "utf8");

  const synced = JSON.parse(
    await runCli(repoDir, [
      "github",
      "sync-pr",
      "HEAD",
      "--pr",
      "123",
      "--release-tag",
      "recipe-artifacts",
      "--json",
    ], {
      env,
    }),
  );

  const localBundlePath = path.join(repoDir, "outputs", `${targetCommit.slice(0, 12)}.recipe.json.zst`);
  const localBundleBytes = await readFile(localBundlePath);
  const originalFetch = global.fetch;
  global.fetch = async (input) => {
    if (String(input) === synced.remoteArtifacts.artifactUrl) {
      return new Response(localBundleBytes, {
        status: 200,
        headers: { "content-type": "application/zstd" },
      });
    }
    return new Response("missing", { status: 404 });
  };

  try {
    const resolved = await resolveRecipeRefFromPullRequest(123, { cwd: repoDir, env });
    assert.equal(resolved.kind, "artifact_url");
    assert.equal(resolved.ref, synced.remoteArtifacts.artifactUrl);

    const recipe = await readRecipeBundle(resolved.ref, { cwd: repoDir });
    assert.equal(recipe.repo.targetCommit, targetCommit);

    const replay = await replayRecipe(recipe, { cwd: repoDir });
    assert.equal(replay.status, "exact");
  } finally {
    global.fetch = originalFetch;
  }
});

test("inspect can resolve a PR ref to the PR head commit when no recipe comment exists yet", async () => {
  const repoDir = await createTempRepo("recipe-pr-resolve-head");
  const baseCommit = await commitFile(
    repoDir,
    "hello.js",
    "module.exports = { value: 1 };\n",
    "base",
  );
  const targetCommit = await commitFile(
    repoDir,
    "hello.js",
    "module.exports = { value: 2 };\n",
    "target",
  );
  const patch = await diff(repoDir, baseCommit, targetCommit);
  const draftPath = path.join(repoDir, "draft.json");
  await writeFile(
    draftPath,
    `${JSON.stringify({
      metadata: { sourceAgent: "codex", adapterVersion: "0.1.0" },
      repo: { baseCommit, targetCommit },
      instructions: { prompts: ["Update exported value."] },
      events: [
        {
          type: "file_edit_checkpoint",
          actor: "agent",
          summary: "Capture hello.js change",
          patch,
        },
      ],
      outputs: {},
      privacy: {},
    }, null, 2)}\n`,
    "utf8",
  );
  await runCli(repoDir, ["capture", "--input", draftPath]);

  const fakeGh = await installFakeGh();
  const env = {
    PATH: `${fakeGh.fakeDir}${path.delimiter}${process.env.PATH}`,
    RECIPE_GH_EXECUTABLE: process.execPath,
    RECIPE_GH_SCRIPT: fakeGh.scriptPath,
    RECIPE_FAKE_GH_STATE: fakeGh.statePath,
  };
  const state = JSON.parse(await readFile(fakeGh.statePath, "utf8"));
  state.pulls["321"] = {
    number: 321,
    head: {
      sha: targetCommit,
      ref: "feature/head-only",
    },
  };
  await writeFile(fakeGh.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  const inspect = await runCli(repoDir, ["inspect", "pr:321"], { env });
  assert.match(inspect, /pr:\s+#321/);
  assert.match(inspect, /via:\s+pull_request_head/);
  assert.match(inspect, new RegExp(`target:\\s+${targetCommit}`));

  const verify = JSON.parse(
    await runCli(repoDir, ["verify", "pr:321", "--json"], { env }),
  );
  assert.equal(verify.ok, true);
  assert.equal(verify.resolved.kind, "pull_request");
  assert.equal(verify.resolved.source, "pull_request_head");
  assert.equal(verify.resolved.metadata.prNumber, 321);
});

test("inspect explains which recipe comment was selected on an ambiguous PR and supports explicit selectors", async () => {
  const repoDir = await createTempRepo("recipe-pr-ambiguous");
  const baseCommit = await commitFile(
    repoDir,
    "hello.js",
    "module.exports = { value: 1 };\n",
    "base",
  );
  const targetOne = await commitFile(
    repoDir,
    "hello.js",
    "module.exports = { value: 2 };\n",
    "target-one",
  );
  const patchOne = await diff(repoDir, baseCommit, targetOne);
  const draftOne = path.join(repoDir, "draft-one.json");
  await writeFile(
    draftOne,
    `${JSON.stringify({
      metadata: { sourceAgent: "codex", adapterVersion: "0.1.0", recipeId: "recipe-one" },
      repo: { baseCommit, targetCommit: targetOne },
      instructions: { prompts: ["Update exported value to 2."] },
      events: [{ type: "file_edit_checkpoint", actor: "agent", summary: "Capture hello.js change", patch: patchOne }],
      outputs: {},
      privacy: {},
    }, null, 2)}\n`,
    "utf8",
  );
  await runCli(repoDir, ["capture", "--input", draftOne]);

  const targetTwo = await commitFile(
    repoDir,
    "hello.js",
    "module.exports = { value: 3 };\n",
    "target-two",
  );
  const patchTwo = await diff(repoDir, targetOne, targetTwo);
  const draftTwo = path.join(repoDir, "draft-two.json");
  await writeFile(
    draftTwo,
    `${JSON.stringify({
      metadata: { sourceAgent: "codex", adapterVersion: "0.1.0", recipeId: "recipe-two" },
      repo: { baseCommit: targetOne, targetCommit: targetTwo },
      instructions: { prompts: ["Update exported value to 3."] },
      events: [{ type: "file_edit_checkpoint", actor: "agent", summary: "Capture second hello.js change", patch: patchTwo }],
      outputs: {},
      privacy: {},
    }, null, 2)}\n`,
    "utf8",
  );
  await runCli(repoDir, ["capture", "--input", draftTwo]);

  const recipeOne = await readRecipeBundle(targetOne, { cwd: repoDir });
  const recipeTwo = await readRecipeBundle(targetTwo, { cwd: repoDir });

  const fakeGh = await installFakeGh();
  const env = {
    PATH: `${fakeGh.fakeDir}${path.delimiter}${process.env.PATH}`,
    RECIPE_GH_EXECUTABLE: process.execPath,
    RECIPE_GH_SCRIPT: fakeGh.scriptPath,
    RECIPE_FAKE_GH_STATE: fakeGh.statePath,
  };
  const state = JSON.parse(await readFile(fakeGh.statePath, "utf8"));
  state.pulls["456"] = {
    number: 456,
    head: {
      sha: targetTwo,
      ref: "feature/ambiguous",
    },
  };
  state.comments = [
    {
      id: 11,
      user: { login: "vivekparekh8" },
      body: addGitHubCommentMarker(
        buildReviewComment(recipeOne),
        {
          recipeId: recipeOne.metadata.recipeId,
          targetCommit: recipeOne.repo.targetCommit,
        },
      ),
    },
    {
      id: 22,
      user: { login: "vivekparekh8" },
      body: addGitHubCommentMarker(
        buildReviewComment(recipeTwo),
        {
          recipeId: recipeTwo.metadata.recipeId,
          targetCommit: recipeTwo.repo.targetCommit,
        },
      ),
    },
  ];
  await writeFile(fakeGh.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  const inspectLatest = await runCli(repoDir, ["inspect", "pr:456"], { env });
  assert.match(inspectLatest, /pr:\s+#456/);
  assert.match(inspectLatest, /via:\s+recipe_comment_commit/);
  assert.match(inspectLatest, /comment:\s+#22/);
  assert.match(inspectLatest, /recipes:\s+2 \(latest comment selected\)/);
  assert.match(inspectLatest, /select:\s+pr:456#11 or pr:456@/);
  assert.match(inspectLatest, new RegExp(`target:\\s+${targetTwo}`));

  const inspectCommentSelector = await runCli(repoDir, ["inspect", "pr:456#11"], { env });
  assert.match(inspectCommentSelector, /comment:\s+#11/);
  assert.match(inspectCommentSelector, new RegExp(`target:\\s+${targetOne}`));

  const inspectCommitSelector = await runCli(
    repoDir,
    ["inspect", `pr:456@${targetOne.slice(0, 12)}`],
    { env },
  );
  assert.match(inspectCommitSelector, /comment:\s+#11/);
  assert.match(inspectCommitSelector, new RegExp(`target:\\s+${targetOne}`));

  const resolvedJson = JSON.parse(
    await runCli(repoDir, ["resolve", "pr:456", "--json"], { env }),
  );
  assert.equal(resolvedJson.kind, "pull_request");
  assert.equal(resolvedJson.source, "recipe_comment_commit");
  assert.equal(resolvedJson.metadata.prNumber, 456);
  assert.equal(resolvedJson.metadata.commentId, 22);
  assert.equal(resolvedJson.metadata.candidates.length, 2);
  assert.equal(resolvedJson.metadata.ambiguous, true);
  assert.equal(resolvedJson.metadata.selectionReason, "latest_comment");
});

test("PR resolution can recover the remote bundle from hidden manifest metadata even if visible URLs are missing", async () => {
  const repoDir = await createTempRepo("recipe-pr-manifest-meta");
  const baseCommit = await commitFile(
    repoDir,
    "hello.js",
    "module.exports = { value: 1 };\n",
    "base",
  );
  const targetCommit = await commitFile(
    repoDir,
    "hello.js",
    "module.exports = { value: 2 };\n",
    "target",
  );

  const fakeGh = await installFakeGh();
  const env = {
    PATH: `${fakeGh.fakeDir}${path.delimiter}${process.env.PATH}`,
    RECIPE_GH_EXECUTABLE: process.execPath,
    RECIPE_GH_SCRIPT: fakeGh.scriptPath,
    RECIPE_FAKE_GH_STATE: fakeGh.statePath,
  };
  const state = JSON.parse(await readFile(fakeGh.statePath, "utf8"));
  state.pulls["654"] = {
    number: 654,
    head: {
      sha: targetCommit,
      ref: "feature/manifest-meta",
    },
  };
  state.comments = [
    {
      id: 77,
      user: { login: "vivekparekh8" },
      body: addGitHubCommentMarker(
        "## recipe\n\nvisible links were trimmed",
        {
          recipeId: "recipe-meta",
          targetCommit,
          metadata: {
            manifestUrl: "https://example.test/recipe-publish.json",
            releaseTag: "recipe-artifacts",
            manifestName: "abcdef.recipe-publish.json",
          },
        },
      ),
    },
  ];
  await writeFile(fakeGh.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  const originalFetch = global.fetch;
  global.fetch = async (input) => {
    if (String(input) === "https://example.test/recipe-publish.json") {
      return new Response(JSON.stringify({
        remoteArtifacts: {
          artifactUrl: "https://example.test/recipe.json.zst",
          summaryUrl: "https://example.test/recipe.md",
          releaseUrl: "https://github.com/vivekparekh8/recipe/releases/tag/recipe-artifacts",
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("missing", { status: 404 });
  };

  try {
    const resolved = await resolveRecipeRefFromPullRequest(654, { cwd: repoDir, env });
    assert.equal(resolved.kind, "artifact_url_manifest");
    assert.equal(resolved.ref, "https://example.test/recipe.json.zst");
    assert.equal(resolved.urls.manifestUrl, "https://example.test/recipe-publish.json");
    assert.equal(resolved.urls.summaryUrl, "https://example.test/recipe.md");

    const wrapped = await resolveRecipeRefInput("pr:654", { cwd: repoDir, env });
    const described = describeResolvedRecipeRef(wrapped).join("\n");
    assert.match(described, /pr:\s+#654/);
    assert.match(described, /via:\s+artifact_url_manifest/);
    assert.match(described, /manifest:\s+https:\/\/example\.test\/recipe-publish\.json/);
    assert.match(described, /summary:\s+https:\/\/example\.test\/recipe\.md/);
    assert.match(described, /release:\s+https:\/\/github\.com\/vivekparekh8\/recipe\/releases\/tag\/recipe-artifacts/);
  } finally {
    global.fetch = originalFetch;
  }
});
