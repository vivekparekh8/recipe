import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_NOTES_REF } from "../core/attachment.js";
import {
  inspectRecipeHook,
  installRecipeHook,
  uninstallRecipeHook,
} from "../core/hooks.js";
import {
  clearActiveSession,
  finalizeCaptureSession,
  readActiveSession,
  readCaptureSession,
} from "../core/session.js";
import { runPublishCommand } from "./publish.js";

export function installedCliPath() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
}

export async function runHooksCommand({ positionals, options }) {
  const cwd = options.cwd ?? process.cwd();
  const subcommand = positionals[0] ?? "help";

  if (subcommand === "help") {
    console.log(`hooks

Usage:
  recipe hooks install
  recipe hooks uninstall
  recipe hooks status
  recipe hooks run-post-commit
`);
    return;
  }

  if (subcommand === "install") {
    const result = await installRecipeHook(cwd, installedCliPath());
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`${result.alreadyInstalled ? "Recipe hook already installed" : "Installed Recipe hook"}:
  post-commit: ${result.path}
  Git hook configuration was not changed.`);
    return;
  }

  if (subcommand === "uninstall") {
    const result = await uninstallRecipeHook(cwd);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(result.removed
      ? `Removed Recipe's managed block from ${result.path}.`
      : "Recipe hook is not installed.");
    return;
  }

  if (subcommand === "status") {
    const hook = await inspectRecipeHook(cwd);
    const activeSession = await readActiveSession({ cwd });
    const result = {
      repoRoot: hook.repoRoot,
      postCommitPath: hook.path,
      postCommitExists: hook.exists,
      managed: hook.managed,
      compatible: hook.compatible,
      active: Boolean(activeSession?.sessionId),
    };
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`Recipe hook status:
  post-commit: ${hook.path}
  installed:   ${hook.managed ? "yes" : "no"}
  compatible:  ${hook.compatible ? "yes" : "no"}
  active run:  ${result.active ? "yes" : "no"}`);
    return;
  }

  if (subcommand === "run-post-commit") {
    const activeSession = await readActiveSession({ cwd });
    if (!activeSession?.sessionId) {
      if (options.json) {
        console.log(JSON.stringify({ ok: true, skipped: true, reason: "no-active-session" }, null, 2));
      }
      return;
    }

    const session = await readCaptureSession(activeSession.sessionId, { cwd });
    const finalized = await finalizeCaptureSession(
      session.sessionId,
      { targetRef: "HEAD" },
      { cwd },
    );
    await runPublishCommand({
      positionals: ["HEAD"],
      options: {
        cwd,
        json: false,
        attach: true,
        "notes-ref": DEFAULT_NOTES_REF,
      },
    });
    await clearActiveSession({ cwd });

    if (options.json) {
      console.log(JSON.stringify({
        ok: true,
        targetCommit: finalized.targetCommit,
        recipePath: finalized.stored.path,
      }, null, 2));
    }
    return;
  }

  throw new Error(`Unknown hooks subcommand "${subcommand}".`);
}
