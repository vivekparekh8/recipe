import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveCommit,
  resolveGitDir,
  resolveRepoRoot,
} from "../core/git.js";
import { detectAgents } from "../core/environment.js";
import { installRecipeHook } from "../core/hooks.js";
import {
  ensureDir,
  pathExists,
  readJsonFile,
  writeJsonFile,
} from "../core/utils.js";

const PROJECT_CONFIG_VERSION = "0.1.0";

async function projectPaths(cwd) {
  const repoRoot = await resolveRepoRoot(cwd);
  const gitDir = await resolveGitDir(cwd);
  const stateDir = path.join(gitDir, "recipe");
  return {
    repoRoot,
    gitDir,
    stateDir,
    configPath: path.join(stateDir, "config.json"),
  };
}

export async function readProjectConfig({ cwd } = {}) {
  const paths = await projectPaths(cwd);
  if (!await pathExists(paths.configPath)) {
    return { ...paths, config: null };
  }
  return {
    ...paths,
    config: await readJsonFile(paths.configPath),
  };
}

export async function requireInitializedProject({ cwd } = {}) {
  const project = await readProjectConfig({ cwd });
  if (!project.config) {
    throw new Error('Recipe is not initialized. Run "recipe init" first.');
  }
  if (project.config.version !== PROJECT_CONFIG_VERSION) {
    throw new Error(
      `Unsupported local Recipe config version "${project.config.version}". Expected "${PROJECT_CONFIG_VERSION}".`,
    );
  }
  return project;
}

export async function runInitCommand({ options }) {
  const cwd = options.cwd ?? process.cwd();
  const paths = await projectPaths(cwd);
  await resolveCommit("HEAD", { cwd }).catch(() => {
    throw new Error("Recipe requires a repository with at least one commit.");
  });

  await ensureDir(paths.stateDir);
  await ensureDir(path.join(paths.gitDir, "recipes"));
  await ensureDir(path.join(paths.gitDir, "recipe-sessions"));
  await ensureDir(path.join(paths.gitDir, "recipe-publish"));

  const existing = await pathExists(paths.configPath)
    ? await readJsonFile(paths.configPath)
    : null;
  if (existing && existing.version !== PROJECT_CONFIG_VERSION) {
    throw new Error(
      `Unsupported local Recipe config version "${existing.version}". Expected "${PROJECT_CONFIG_VERSION}".`,
    );
  }

  const config = existing ?? {
    version: PROJECT_CONFIG_VERSION,
    initializedAt: new Date().toISOString(),
    workflow: {
      autoCommit: false,
      attach: true,
    },
  };
  if (!existing) {
    await writeJsonFile(paths.configPath, config);
  }

  const agents = await detectAgents();
  let hook;
  if (options.hooks === false) {
    hook = { installed: false, skipped: true, reason: "disabled" };
  } else {
    const cliPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "cli.js",
    );
    try {
      hook = await installRecipeHook(cwd, cliPath);
    } catch (error) {
      hook = { installed: false, warning: error.message };
    }
  }

  const result = {
    initialized: true,
    alreadyInitialized: Boolean(existing),
    repoRoot: paths.repoRoot,
    configPath: paths.configPath,
    version: config.version,
    agents,
    hook,
  };
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`${existing ? "Recipe already initialized" : "Initialized Recipe"}:
  repo:   ${paths.repoRoot}
  config: ${paths.configPath}
  agents: ${agents.map((agent) => agent.name).join(", ") || "none"}
  hook:   ${hook.managed ? "installed" : hook.warning ? "needs attention" : "skipped"}
${hook.warning ? `\nWarning: ${hook.warning}\n` : ""}

Next: recipe run --prompt "Describe the change" -- <agent command>`);
}
