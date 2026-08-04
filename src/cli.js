#!/usr/bin/env node

import { buildAgentCommand } from "./commands/agent.js";
import { runCaptureCommand } from "./commands/capture.js";
import { runDiffReplayCommand } from "./commands/diff-replay.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runGitHubCommand } from "./commands/github.js";
import { runHooksCommand } from "./commands/hooks.js";
import { runInitCommand } from "./commands/init.js";
import { runInspectCommand } from "./commands/inspect.js";
import { runPublishCommand } from "./commands/publish.js";
import { runReplayCommand } from "./commands/replay.js";
import { runResolveCommand } from "./commands/resolve.js";
import { runRunCommand } from "./commands/run.js";
import { runSchemaCommand, runValidateCommand } from "./commands/spec.js";
import { runStatusCommand } from "./commands/status.js";
import { runVerifyCommand } from "./commands/verify.js";

const COMMANDS = {
  init: runInitCommand,
  doctor: runDoctorCommand,
  status: runStatusCommand,
  run: runRunCommand,
  capture: runCaptureCommand,
  publish: runPublishCommand,
  inspect: runInspectCommand,
  resolve: runResolveCommand,
  verify: runVerifyCommand,
  replay: runReplayCommand,
  "diff-replay": runDiffReplayCommand,
  codex: buildAgentCommand("codex"),
  claude: buildAgentCommand("claude"),
  github: runGitHubCommand,
  hooks: runHooksCommand,
  schema: runSchemaCommand,
  validate: runValidateCommand,
};

function printHelp() {
  console.log(`recipe

Usage:
  recipe <command> [options]

Commands:
  init          Initialize local Recipe state for this repository
  doctor        Diagnose repository and Recipe prerequisites
  status        Show repository, run, hook, agent, and attachment state
  run           Run an agent and capture changes with explicit commit consent
  capture       Start/append/finalize a local capture session or import a recipe draft
  codex         Thin Codex adapter over the shared recorder
  claude        Thin Claude Code adapter over the shared recorder
  github        Backendless GitHub bridge for syncing recipe PR comments
  hooks         Install or run local git-hook automation
  schema        Print the open JSON Schemas for recipe bundles and ingest records
  validate      Validate a recipe bundle or ingest stream against the open spec
  publish       Generate local artifacts and attach trailer metadata to the commit via git notes
  inspect       Print recipe details or file attribution
  resolve       Resolve a commit/PR/url ref to the concrete recipe source and metadata
  verify        Audit recipe integrity, attachment consistency, and optional replay drift
  replay        Deterministically replay a captured recipe
  diff-replay   Replay and print the diff against the captured target

Examples:
  recipe init
  recipe doctor
  recipe status
  recipe run --commit --prompt "Fix the parser bug" -- codex
  recipe codex start --prompt "Fix calc"
  recipe codex step --session <id> --command "node scripts/apply-fix.js"
  recipe codex observe --session <id> --command "codex run ..."
  recipe codex ingest --session <id> --stdin
  recipe claude start --prompt "Refactor parser"
  recipe github sync-pr --pr 123 HEAD
  recipe github sync-pr --pr 123 HEAD --release-tag recipe-artifacts
  recipe hooks install
  recipe schema recipe
  recipe validate ingest events.jsonl
  recipe capture --start --source-agent codex --base HEAD --prompt "Fix calc"
  recipe capture --checkpoint --session <id> --summary "Apply agent edits"
  recipe capture --record-test --session <id> --command "npm test"
  recipe capture --finalize --session <id> --target HEAD
  recipe capture --input work/example-recipe.json
  recipe inspect HEAD
  recipe resolve pr:123 --json
  recipe inspect pr:123
  recipe inspect pr:123#45
  recipe inspect pr:123@abcdef12
  recipe verify HEAD --replay
  recipe verify pr:123 --replay
  recipe inspect https://github.com/owner/repo/releases/download/recipe-artifacts/<bundle>.json.zst
  recipe publish HEAD --release-tag recipe-artifacts
  recipe replay HEAD
  recipe replay pr:123
  recipe publish HEAD
`);
}

function parseArgs(argv) {
  const positionals = [];
  const options = {};
  let passthrough = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      passthrough = argv.slice(index + 1);
      break;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    if (token === "--help") {
      options.help = true;
      continue;
    }

    if (token.startsWith("--no-")) {
      options[token.slice(5)] = false;
      continue;
    }

    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      options[rawKey] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options[rawKey] = true;
      continue;
    }

    options[rawKey] = next;
    index += 1;
  }

  return { positionals, options, passthrough };
}

async function main() {
  const [, , commandName, ...rest] = process.argv;

  if (!commandName || commandName === "help" || commandName === "--help") {
    printHelp();
    return;
  }

  const command = COMMANDS[commandName];
  if (!command) {
    throw new Error(`Unknown command "${commandName}". Run "recipe --help" for usage.`);
  }

  const parsed = parseArgs(rest);
  if (parsed.options.help) {
    printHelp();
    return;
  }

  await command(parsed);
}

main().catch((error) => {
  console.error(error.message);
  if (error.stack && process.env.RECIPE_DEBUG === "1") {
    console.error(error.stack);
  }
  process.exitCode = 1;
});
