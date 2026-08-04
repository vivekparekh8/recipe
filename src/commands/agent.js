import { readFile } from "node:fs/promises";

import {
  appendPromptToSession,
  appendTranscriptToSession,
  captureSessionCheckpoint,
  createCaptureSession,
  finalizeCaptureSession,
  importSessionRecords,
  observeCommandForSession,
  runCommandForSession,
  runTestForSession,
} from "../core/session.js";
import { parseJsonLines } from "../core/utils.js";

function render(result, options, textRenderer) {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(textRenderer(result));
}

function requireSession(options, subcommand) {
  if (!options.session) {
    throw new Error(`Expected "--session <id>" for "${subcommand}".`);
  }
  return options.session;
}

async function readImportRecords(options) {
  if (options["event-log"]) {
    const text = await readFile(options["event-log"], "utf8");
    return parseJsonLines(text);
  }

  if (options.stdin === true) {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    return parseJsonLines(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"));
  }

  throw new Error('Expected "--event-log <path>" or "--stdin" for "ingest".');
}

export function buildAgentCommand(agentName) {
  return async function runAgentCommand({ positionals, options }) {
    const cwd = options.cwd ?? process.cwd();
    const subcommand = positionals[0] ?? "help";

    if (subcommand === "help") {
      console.log(`${agentName} adapter

Usage:
  recipe ${agentName} start --prompt "..."
  recipe ${agentName} step --session <id> --command "..."
  recipe ${agentName} observe --session <id> --command "..."
  recipe ${agentName} ingest --session <id> --event-log events.jsonl
  recipe ${agentName} checkpoint --session <id>
  recipe ${agentName} test --session <id> --command "..."
  recipe ${agentName} transcript --session <id> --text "..."
  recipe ${agentName} prompt --session <id> --prompt "..."
  recipe ${agentName} finalize --session <id> --target HEAD
`);
      return;
    }

    if (subcommand === "start") {
      const session = await createCaptureSession(
        {
          sessionId: options.session,
          sourceAgent: agentName === "claude" ? "claude-code" : agentName,
          adapterVersion: options["adapter-version"] ?? "0.1.0",
          baseRef: options.base ?? "HEAD",
          prompt: options.prompt ?? null,
          actor: options.actor ?? "user",
          activate: options.activate !== false,
        },
        { cwd },
      );

      render(
        {
          sessionId: session.sessionId,
          sourceAgent: session.metadata.sourceAgent,
          baseCommit: session.repo.baseCommit,
        },
        options,
        (value) => `Started ${agentName} session:
  session: ${value.sessionId}
          source:  ${value.sourceAgent}
  base:    ${value.baseCommit}`,
      );
      return;
    }

    if (subcommand === "prompt") {
      const sessionId = requireSession(options, subcommand);
      if (!options.prompt) {
        throw new Error('Expected "--prompt <text>" for "prompt".');
      }
      const event = await appendPromptToSession(
        sessionId,
        options.prompt,
        {
          actor: options.actor ?? "user",
          summary: options.summary,
        },
        { cwd },
      );
      render(
        { sessionId, event },
        options,
        (value) => `Recorded prompt:
  session: ${value.sessionId}
  event:   ${value.event.id}`,
      );
      return;
    }

    if (subcommand === "step") {
      const sessionId = requireSession(options, subcommand);
      if (!options.command) {
        throw new Error('Expected "--command <shell command>" for "step".');
      }
      const result = await runCommandForSession(
        sessionId,
        options.command,
        {
          prompt: options.prompt ?? null,
          promptActor: options["prompt-actor"] ?? "user",
          actor: options.actor ?? "agent",
          summary: options.summary ?? null,
          checkpoint: options.checkpoint !== false,
          checkpointEventType: options["event-type"] ?? null,
          checkpointSummary: options["checkpoint-summary"] ?? null,
        },
        { cwd },
      );

      render(
        {
          sessionId,
          ...result,
        },
        options,
        (value) => `Recorded ${agentName} step:
  session:    ${value.sessionId}
  exit:       ${value.shell.exitCode}
  checkpoint: ${value.checkpoint?.appended ? value.checkpoint.event.id : "none"}`,
      );
      return;
    }

    if (subcommand === "observe") {
      const sessionId = requireSession(options, subcommand);
      if (!options.command) {
        throw new Error('Expected "--command <shell command>" for "observe".');
      }
      const result = await observeCommandForSession(
        sessionId,
        options.command,
        {
          prompt: options.prompt ?? null,
          promptActor: options["prompt-actor"] ?? "user",
          actor: options.actor ?? "agent",
          summary: options.summary ?? null,
          checkpoint: options.checkpoint !== false,
          checkpointEventType: options["event-type"] ?? null,
          checkpointSummary: options["checkpoint-summary"] ?? null,
          echo: options.json !== true && options.quiet !== true,
        },
        { cwd },
      );

      render(
        {
          sessionId,
          ...result,
        },
        options,
        (value) => `Observed ${agentName} command:
  session:    ${value.sessionId}
  exit:       ${value.shell.exitCode}
  transcript: ${value.transcript.transcriptPath}
  checkpoint: ${value.checkpoint?.appended ? value.checkpoint.event.id : "none"}`,
      );
      return;
    }

    if (subcommand === "ingest") {
      const sessionId = requireSession(options, subcommand);
      const result = await importSessionRecords(
        sessionId,
        await readImportRecords(options),
        { cwd },
      );
      render(
        result,
        options,
        (value) => `Imported streamed records:
  session:   ${value.sessionId}
  processed: ${value.processedCount}`,
      );
      return;
    }

    if (subcommand === "checkpoint") {
      const sessionId = requireSession(options, subcommand);
      const result = await captureSessionCheckpoint(
        sessionId,
        {
          eventType: options["event-type"] ?? "file_edit_checkpoint",
          actor: options.actor ?? "agent",
          summary: options.summary,
        },
        { cwd },
      );
      render(
        {
          sessionId,
          ...result,
        },
        options,
        (value) => value.appended
          ? `Captured checkpoint:
  session: ${value.sessionId}
  event:   ${value.event.id}`
          : `No checkpoint captured for ${value.sessionId}.`,
      );
      return;
    }

    if (subcommand === "test") {
      const sessionId = requireSession(options, subcommand);
      if (!options.command) {
        throw new Error('Expected "--command <shell command>" for "test".');
      }
      const result = await runTestForSession(
        sessionId,
        options.command,
        {
          summary: options.summary,
        },
        { cwd },
      );
      render(
        {
          sessionId,
          ...result,
        },
        options,
        (value) => `Recorded test:
  session: ${value.sessionId}
  event:   ${value.eventId}
  exit:    ${value.exitCode}`,
      );
      return;
    }

    if (subcommand === "transcript") {
      const sessionId = requireSession(options, subcommand);
      const text = options.text ?? (
        options.file
          ? await readFile(options.file, "utf8")
          : null
      );
      if (!text) {
        throw new Error('Expected "--text <value>" or "--file <path>" for "transcript".');
      }
      const result = await appendTranscriptToSession(sessionId, text, { cwd });
      render(
        result,
        options,
        (value) => `Updated transcript:
  session: ${value.sessionId}
  path:    ${value.transcriptPath}`,
      );
      return;
    }

    if (subcommand === "finalize") {
      const sessionId = requireSession(options, subcommand);
      const result = await finalizeCaptureSession(
        sessionId,
        {
          targetRef: options.target ?? "HEAD",
        },
        { cwd },
      );
      render(
        result,
        options,
        (value) => `Finalized ${agentName} recipe:
  session: ${value.sessionId}
  target:  ${value.targetCommit}
  bundle:  ${value.stored.path}`,
      );
      return;
    }

    throw new Error(`Unknown ${agentName} subcommand "${subcommand}".`);
  };
}
