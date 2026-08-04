import { readFile } from "node:fs/promises";

import { normalizeRecipe } from "../core/recipe.js";
import {
  appendEventToSession,
  appendPromptToSession,
  appendTranscriptToSession,
  captureSessionCheckpoint,
  createCaptureSession,
  finalizeCaptureSession,
  runTestForSession,
} from "../core/session.js";
import { writeRecipeBundle } from "../core/storage.js";
import { parseJsonLines, readJsonFile } from "../core/utils.js";

async function buildDraftFromEventLog(options) {
  const eventLogPath = options["event-log"];
  if (!eventLogPath) {
    throw new Error('Expected "--input <file>" or "--event-log <file>".');
  }

  const eventLog = await readFile(eventLogPath, "utf8");
  const events = parseJsonLines(eventLog);

  let prompts = [];
  if (options.prompts) {
    const promptsText = await readFile(options.prompts, "utf8");
    if (options.prompts.endsWith(".json")) {
      prompts = JSON.parse(promptsText);
    } else {
      prompts = promptsText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    }
  }

  return {
    metadata: {
      sourceAgent: options["source-agent"] ?? "unknown",
      adapterVersion: options["adapter-version"] ?? "0.1.0",
      createdAt: options["created-at"],
      capturedAt: options["captured-at"],
    },
    repo: {
      baseCommit: options.base,
      targetCommit: options.target,
      remoteFingerprint: options["remote-fingerprint"] ?? null,
      treeFingerprint: options["tree-fingerprint"] ?? null,
    },
    instructions: {
      prompts,
      referencedArtifacts: [],
      promptRevisions: [],
    },
    events,
    outputs: {},
    privacy: {
      redactions: [],
      omittedBlobs: [],
      secretScanFindings: [],
    },
  };
}

async function parseEventInput(options) {
  if (options["append-event"]) {
    return JSON.parse(options["append-event"]);
  }
  if (options["event-file"]) {
    return readJsonFile(options["event-file"]);
  }
  throw new Error('Expected "--append-event <json>" or "--event-file <path>".');
}

function printResult(result, options, renderText) {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(renderText(result));
}

export async function runCaptureCommand({ options }) {
  const cwd = options.cwd ?? process.cwd();

  if (options.start) {
    const session = await createCaptureSession(
      {
        sessionId: options.session,
        sourceAgent: options["source-agent"] ?? "unknown",
        adapterVersion: options["adapter-version"] ?? "0.1.0",
        baseRef: options.base ?? "HEAD",
        prompt: options.prompt ?? null,
        actor: options.actor ?? "user",
        activate: options.activate === true,
      },
      { cwd },
    );

    printResult(
      {
        sessionId: session.sessionId,
        baseCommit: session.repo.baseCommit,
        sourceAgent: session.metadata.sourceAgent,
        transcriptPath: session.privacy.rawTranscriptPath,
      },
      options,
      (result) => `Started capture session:
  session:    ${result.sessionId}
  base:       ${result.baseCommit}
  source:     ${result.sourceAgent}
  transcript: ${result.transcriptPath}`,
    );
    return;
  }

  if (options["append-prompt"]) {
    if (!options.session) {
      throw new Error('Expected "--session <id>" when using "--append-prompt".');
    }

    const event = await appendPromptToSession(
      options.session,
      options["append-prompt"],
      {
        actor: options.actor ?? "user",
        summary: options.summary,
      },
      { cwd },
    );

    printResult(
      {
        sessionId: options.session,
        event,
      },
      options,
      (result) => `Recorded prompt event:
  session: ${result.sessionId}
  event:   ${result.event.id}
  at:      ${result.event.at}`,
    );
    return;
  }

  if (options["append-event"] || options["event-file"]) {
    if (!options.session) {
      throw new Error('Expected "--session <id>" when appending an event.');
    }

    const event = await appendEventToSession(
      options.session,
      await parseEventInput(options),
      { cwd },
    );

    printResult(
      {
        sessionId: options.session,
        event,
      },
      options,
      (result) => `Recorded event:
  session: ${result.sessionId}
  event:   ${result.event.id}
  type:    ${result.event.type}`,
    );
    return;
  }

  if (options["append-transcript"] || options["transcript-file"]) {
    if (!options.session) {
      throw new Error('Expected "--session <id>" when appending transcript data.');
    }

    const text = options["append-transcript"]
      ?? await readFile(options["transcript-file"], "utf8");
    const result = await appendTranscriptToSession(
      options.session,
      text,
      { cwd },
    );

    printResult(
      result,
      options,
      (value) => `Updated transcript:
  session:    ${value.sessionId}
  transcript: ${value.transcriptPath}
  updated:    ${value.updatedAt}`,
    );
    return;
  }

  if (options.checkpoint) {
    if (!options.session) {
      throw new Error('Expected "--session <id>" when capturing a checkpoint.');
    }

    const result = await captureSessionCheckpoint(
      options.session,
      {
        eventType: options["event-type"] ?? "file_edit_checkpoint",
        actor: options.actor,
        summary: options.summary,
      },
      { cwd },
    );

    printResult(
      {
        sessionId: options.session,
        ...result,
      },
      options,
      (value) => value.appended
        ? `Captured checkpoint:
  session:  ${value.sessionId}
  snapshot: ${value.snapshot}
  event:    ${value.event.id}
  files:    ${value.files.join(", ") || "(none)"}`
        : `No checkpoint captured:
  session:  ${value.sessionId}
  snapshot: ${value.snapshot}`,
    );
    return;
  }

  if (options["record-test"]) {
    if (!options.session) {
      throw new Error('Expected "--session <id>" when recording a test.');
    }
    if (!options.command) {
      throw new Error('Expected "--command <shell command>" when using "--record-test".');
    }

    const result = await runTestForSession(
      options.session,
      options.command,
      {
        summary: options.summary,
      },
      { cwd },
    );

    printResult(
      {
        sessionId: options.session,
        ...result,
      },
      options,
      (value) => `Recorded test run:
  session: ${value.sessionId}
  event:   ${value.eventId}
  exit:    ${value.exitCode}`,
    );
    return;
  }

  if (options.finalize) {
    if (!options.session) {
      throw new Error('Expected "--session <id>" when finalizing a capture.');
    }

    const result = await finalizeCaptureSession(
      options.session,
      {
        targetRef: options.target ?? "HEAD",
      },
      { cwd },
    );

    printResult(
      result,
      options,
      (value) => `Finalized capture session:
  session: ${value.sessionId}
  target:  ${value.targetCommit}
  bundle:  ${value.stored.path}
  sha256:  ${value.stored.sha256}`,
    );
    return;
  }

  let draft;
  if (options.input) {
    draft = await readJsonFile(options.input);
  } else {
    draft = await buildDraftFromEventLog(options);
  }

  const recipe = await normalizeRecipe(draft, { cwd });
  const stored = await writeRecipeBundle(recipe, { cwd });

  console.log(`Stored recipe bundle:
  target: ${recipe.repo.targetCommit}
  path:   ${stored.path}
  sha256: ${stored.sha256}
  status: ${recipe.outputs.provenanceStatus}
  events: ${recipe.events.length}`);
}
