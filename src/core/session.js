import { randomUUID } from "node:crypto";
import { appendFile, readFile, rm } from "node:fs/promises";
import path from "node:path";

import {
  diffRefs,
  getRemoteFingerprint,
  resolveCommit,
  resolveGitDir,
  resolveTree,
  runShell,
  runShellStreaming,
  snapshotWorktreeTree,
} from "./git.js";
import { extractTouchedFiles } from "./patch.js";
import { normalizeRecipe } from "./recipe.js";
import { writeRecipeBundle } from "./storage.js";
import {
  appendTextFile,
  ensureDir,
  parseJsonLines,
  readJsonFile,
  writeJsonFile,
  writeTextFile,
} from "./utils.js";

const SESSION_VERSION = "0.1.0";

function buildEventId() {
  return `evt_${randomUUID()}`;
}

function promptSummary(prompt) {
  const compact = prompt.trim().replace(/\s+/g, " ");
  return compact.length <= 80 ? compact : `${compact.slice(0, 77)}...`;
}

async function sessionsRoot(cwd) {
  const gitDir = await resolveGitDir(cwd);
  const root = path.join(gitDir, "recipe-sessions");
  await ensureDir(root);
  return root;
}

async function sessionDir(sessionId, cwd) {
  return path.join(await sessionsRoot(cwd), sessionId);
}

async function sessionStatePath(sessionId, cwd) {
  return path.join(await sessionDir(sessionId, cwd), "session.json");
}

async function sessionEventsPath(sessionId, cwd) {
  return path.join(await sessionDir(sessionId, cwd), "events.jsonl");
}

async function sessionTranscriptPath(sessionId, cwd) {
  return path.join(await sessionDir(sessionId, cwd), "transcript.log");
}

async function activeSessionPath(cwd) {
  const gitDir = await resolveGitDir(cwd);
  return path.join(gitDir, "recipe-active-session.json");
}

async function persistSession(session, cwd) {
  const filePath = await sessionStatePath(session.sessionId, cwd);
  await writeJsonFile(filePath, session);
}

async function appendSessionEventLine(sessionId, event, cwd) {
  const filePath = await sessionEventsPath(sessionId, cwd);
  await appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
}

function normalizeSessionEvent(event) {
  const normalized = {
    ...event,
    id: event.id ?? buildEventId(),
    at: event.at ?? new Date().toISOString(),
  };

  if (normalized.patch && !normalized.files) {
    normalized.files = extractTouchedFiles(normalized.patch);
  }

  return normalized;
}

async function recordEvent(session, event, cwd) {
  const normalized = normalizeSessionEvent(event);
  await appendSessionEventLine(session.sessionId, normalized, cwd);

  if (normalized.type === "prompt") {
    const prompt = normalized.inputs?.prompt ?? normalized.summary ?? "";
    session.instructions.prompts.push(prompt);
    session.instructions.promptRevisions.push({
      eventId: normalized.id,
      at: normalized.at,
      actor: normalized.actor ?? null,
      prompt,
      revision: session.instructions.promptRevisions.length + 1,
    });
  }

  session.metadata.updatedAt = normalized.at;
  await persistSession(session, cwd);
  return normalized;
}

export async function readCaptureSession(sessionId, { cwd } = {}) {
  return readJsonFile(await sessionStatePath(sessionId, cwd));
}

export async function setActiveSession(
  sessionId,
  {
    sourceAgent = null,
    state = "running",
    pid = null,
  } = {},
  { cwd } = {},
) {
  const filePath = await activeSessionPath(cwd);
  const now = new Date().toISOString();
  await writeJsonFile(filePath, {
    sessionId,
    sourceAgent,
    state,
    pid,
    activatedAt: now,
    updatedAt: now,
  });
  return {
    sessionId,
    sourceAgent,
    state,
    pid,
    activatedAt: now,
    updatedAt: now,
  };
}

export async function updateActiveSession(
  updates,
  { cwd } = {},
) {
  const active = await readActiveSession({ cwd });
  if (!active?.sessionId) {
    return null;
  }
  const updated = {
    ...active,
    ...updates,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonFile(await activeSessionPath(cwd), updated);
  return updated;
}

export async function readActiveSession({ cwd } = {}) {
  try {
    return await readJsonFile(await activeSessionPath(cwd));
  } catch {
    return null;
  }
}

export async function clearActiveSession({ cwd } = {}) {
  await rm(await activeSessionPath(cwd), { force: true });
}

export async function readCaptureSessionEvents(sessionId, { cwd } = {}) {
  const filePath = await sessionEventsPath(sessionId, cwd);
  const contents = await readFile(filePath, "utf8");
  return parseJsonLines(contents);
}

export async function createCaptureSession(
  {
    sessionId = randomUUID(),
    sourceAgent = "unknown",
    adapterVersion = "0.1.0",
    baseRef = "HEAD",
    prompt = null,
    actor = "user",
    activate = false,
  } = {},
  { cwd } = {},
) {
  const dirPath = await sessionDir(sessionId, cwd);
  await ensureDir(dirPath);

  const baseCommit = await resolveCommit(baseRef, { cwd });
  const baseTree = await resolveTree(baseCommit, { cwd });
  const transcriptPath = await sessionTranscriptPath(sessionId, cwd);
  const now = new Date().toISOString();

  const session = {
    version: SESSION_VERSION,
    sessionId,
    recipeId: randomUUID(),
    metadata: {
      sourceAgent,
      adapterVersion,
      createdAt: now,
      updatedAt: now,
    },
    repo: {
      baseCommit,
      currentSnapshot: baseTree,
      remoteFingerprint: await getRemoteFingerprint(cwd),
      treeFingerprint: baseTree,
    },
    instructions: {
      prompts: [],
      referencedArtifacts: [],
      promptRevisions: [],
    },
    privacy: {
      rawTranscriptPath: transcriptPath,
    },
    finalized: null,
  };

  await persistSession(session, cwd);
  await writeTextFile(await sessionEventsPath(sessionId, cwd), "");
  await writeTextFile(transcriptPath, "");

  if (activate) {
    await setActiveSession(
      sessionId,
      {
        sourceAgent,
      },
      { cwd },
    );
  }

  if (prompt) {
    await appendPromptToSession(
      sessionId,
      prompt,
      { actor },
      { cwd },
    );
    return readCaptureSession(sessionId, { cwd });
  }

  return session;
}

export async function appendPromptToSession(
  sessionId,
  prompt,
  { actor = "user", summary } = {},
  { cwd } = {},
) {
  const session = await readCaptureSession(sessionId, { cwd });
  const event = {
    type: "prompt",
    actor,
    summary: summary ?? promptSummary(prompt),
    inputs: {
      prompt,
    },
  };
  return recordEvent(session, event, cwd);
}

export async function appendEventToSession(sessionId, event, { cwd } = {}) {
  const session = await readCaptureSession(sessionId, { cwd });
  return recordEvent(session, event, cwd);
}

async function appendCheckpointForImportedEvent(
  sessionId,
  event,
  {
    checkpoint = false,
    checkpointEventType = null,
    checkpointActor = null,
    checkpointSummary = null,
  } = {},
  { cwd } = {},
) {
  if (!checkpoint) {
    return null;
  }

  return captureSessionCheckpoint(
    sessionId,
    {
      eventType: defaultCheckpointEventType(
        checkpointActor ?? event.actor,
        checkpointEventType,
      ),
      actor: checkpointActor ?? event.actor,
      summary: checkpointSummary ?? event.summary ?? event.command ?? event.toolName ?? "Imported checkpoint",
      causedByEventId: event.id,
    },
    { cwd },
  );
}

function defaultCheckpointEventType(actor, explicitType) {
  if (explicitType) {
    return explicitType;
  }
  return actor === "human" ? "human_edit" : "file_edit_checkpoint";
}

export async function appendTranscriptToSession(
  sessionId,
  text,
  { cwd } = {},
) {
  const session = await readCaptureSession(sessionId, { cwd });
  const transcriptPath = session.privacy?.rawTranscriptPath
    ?? await sessionTranscriptPath(sessionId, cwd);
  const now = new Date().toISOString();
  await appendTextFile(transcriptPath, `${text.endsWith("\n") ? text : `${text}\n`}`);
  session.metadata.updatedAt = now;
  session.privacy.rawTranscriptPath = transcriptPath;
  await persistSession(session, cwd);
  return {
    sessionId,
    transcriptPath,
    updatedAt: now,
  };
}

export async function recordShellResultForSession(
  sessionId,
  {
    command,
    actor = "agent",
    summary = null,
    result = null,
    checkpoint = false,
    checkpointEventType = null,
    checkpointActor = null,
    checkpointSummary = null,
  } = {},
  { cwd } = {},
) {
  const event = await appendEventToSession(
    sessionId,
    {
      type: "shell_command",
      actor,
      summary: summary ?? command,
      command,
      result: result ?? null,
    },
    { cwd },
  );

  const checkpointResult = await appendCheckpointForImportedEvent(
    sessionId,
    event,
    {
      checkpoint,
      checkpointEventType,
      checkpointActor,
      checkpointSummary,
    },
    { cwd },
  );

  return {
    event,
    checkpoint: checkpointResult,
  };
}

export async function recordToolEventForSession(
  sessionId,
  {
    toolName,
    actor = "agent",
    summary = null,
    inputs = null,
    outputs = null,
    checkpoint = false,
    checkpointEventType = null,
    checkpointActor = null,
    checkpointSummary = null,
  } = {},
  { cwd } = {},
) {
  const event = await appendEventToSession(
    sessionId,
    {
      type: "tool_call",
      actor,
      summary: summary ?? toolName,
      toolName,
      inputs,
      outputs,
    },
    { cwd },
  );

  const checkpointResult = await appendCheckpointForImportedEvent(
    sessionId,
    event,
    {
      checkpoint,
      checkpointEventType,
      checkpointActor,
      checkpointSummary,
    },
    { cwd },
  );

  return {
    event,
    checkpoint: checkpointResult,
  };
}

export async function recordTestResultForSession(
  sessionId,
  {
    command,
    actor = "agent",
    summary = null,
    result = null,
  } = {},
  { cwd } = {},
) {
  const event = await appendEventToSession(
    sessionId,
    {
      type: "test_run",
      actor,
      summary: summary ?? command,
      command,
      result: result ?? null,
    },
    { cwd },
  );

  return {
    eventId: event.id,
    event,
    exitCode: event.result?.exitCode ?? null,
  };
}

export async function importSessionRecords(
  sessionId,
  records,
  { cwd } = {},
) {
  const processed = [];

  for (const [index, record] of records.entries()) {
    const kind = record.kind ?? record.type;
    if (!kind) {
      throw new Error(`Imported record ${index + 1} is missing "kind".`);
    }

    if (kind === "prompt") {
      processed.push({
        kind,
        event: await appendPromptToSession(
          sessionId,
          record.prompt,
          {
            actor: record.actor ?? "user",
            summary: record.summary,
          },
          { cwd },
        ),
      });
      continue;
    }

    if (kind === "transcript") {
      processed.push({
        kind,
        transcript: await appendTranscriptToSession(
          sessionId,
          record.text,
          { cwd },
        ),
      });
      continue;
    }

    if (kind === "checkpoint") {
      processed.push({
        kind,
        checkpoint: await captureSessionCheckpoint(
          sessionId,
          {
            eventType: record.eventType ?? "file_edit_checkpoint",
            actor: record.actor,
            summary: record.summary,
            causedByEventId: record.causedByEventId ?? null,
          },
          { cwd },
        ),
      });
      continue;
    }

    if (kind === "shell") {
      processed.push({
        kind,
        ...(await recordShellResultForSession(
          sessionId,
          {
            command: record.command,
            actor: record.actor ?? "agent",
            summary: record.summary ?? null,
            result: record.result ?? null,
            checkpoint: record.checkpoint === true,
            checkpointEventType: record.checkpointEventType ?? null,
            checkpointActor: record.checkpointActor ?? null,
            checkpointSummary: record.checkpointSummary ?? null,
          },
          { cwd },
        )),
      });
      continue;
    }

    if (kind === "tool") {
      processed.push({
        kind,
        ...(await recordToolEventForSession(
          sessionId,
          {
            toolName: record.toolName,
            actor: record.actor ?? "agent",
            summary: record.summary ?? null,
            inputs: record.inputs ?? null,
            outputs: record.outputs ?? null,
            checkpoint: record.checkpoint === true,
            checkpointEventType: record.checkpointEventType ?? null,
            checkpointActor: record.checkpointActor ?? null,
            checkpointSummary: record.checkpointSummary ?? null,
          },
          { cwd },
        )),
      });
      continue;
    }

    if (kind === "test") {
      if (record.execute === true || !record.result) {
        processed.push({
          kind,
          ...(await runTestForSession(
            sessionId,
            record.command,
            {
              summary: record.summary,
            },
            { cwd },
          )),
        });
      } else {
        processed.push({
          kind,
          ...(await recordTestResultForSession(
            sessionId,
            {
              command: record.command,
              actor: record.actor ?? "agent",
              summary: record.summary ?? null,
              result: record.result,
            },
            { cwd },
          )),
        });
      }
      continue;
    }

    if (kind === "event") {
      const event = await appendEventToSession(
        sessionId,
        record.event,
        { cwd },
      );
      const checkpoint = await appendCheckpointForImportedEvent(
        sessionId,
        event,
        {
          checkpoint: record.checkpoint === true,
          checkpointEventType: record.checkpointEventType ?? null,
          checkpointActor: record.checkpointActor ?? null,
          checkpointSummary: record.checkpointSummary ?? null,
        },
        { cwd },
      );
      processed.push({
        kind,
        event,
        checkpoint,
      });
      continue;
    }

    throw new Error(`Unsupported imported record kind "${kind}".`);
  }

  return {
    sessionId,
    processedCount: processed.length,
    processed,
  };
}

export async function runCommandForSession(
  sessionId,
  command,
  {
    prompt = null,
    promptActor = "user",
    actor = "agent",
    summary = null,
    checkpoint = true,
    checkpointEventType = null,
    checkpointSummary = null,
  } = {},
  { cwd } = {},
) {
  const events = [];

  if (prompt) {
    events.push(
      await appendPromptToSession(
        sessionId,
        prompt,
        {
          actor: promptActor,
        },
        { cwd },
      ),
    );
  }

  const shellResult = await runShell(command, { cwd });
  const shellEvent = await appendEventToSession(
    sessionId,
    {
      type: "shell_command",
      actor,
      summary: summary ?? command,
      command,
      result: {
        exitCode: shellResult.code,
        stdout: shellResult.stdout,
        stderr: shellResult.stderr,
      },
    },
    { cwd },
  );
  events.push(shellEvent);

  let checkpointResult = null;
  if (checkpoint) {
    checkpointResult = await captureSessionCheckpoint(
      sessionId,
      {
        eventType: defaultCheckpointEventType(actor, checkpointEventType),
        actor,
        summary: checkpointSummary ?? summary,
        causedByEventId: shellEvent.id,
      },
      { cwd },
    );
  }

  return {
    events,
    shell: {
      exitCode: shellResult.code,
      stdout: shellResult.stdout,
      stderr: shellResult.stderr,
    },
    checkpoint: checkpointResult,
  };
}

export async function observeCommandForSession(
  sessionId,
  command,
  {
    prompt = null,
    promptActor = "user",
    actor = "agent",
    summary = null,
    checkpoint = true,
    checkpointEventType = null,
    checkpointSummary = null,
    echo = false,
  } = {},
  { cwd } = {},
) {
  const events = [];

  if (prompt) {
    events.push(
      await appendPromptToSession(
        sessionId,
        prompt,
        {
          actor: promptActor,
        },
        { cwd },
      ),
    );
  }

  const shellResult = await runShellStreaming(command, {
    cwd,
    onStdout: (text) => {
      if (echo) {
        process.stdout.write(text);
      }
    },
    onStderr: (text) => {
      if (echo) {
        process.stderr.write(text);
      }
    },
  });

  const transcriptChunks = [`$ ${command}`];
  if (shellResult.stdout) {
    transcriptChunks.push(`[stdout]\n${shellResult.stdout}`);
  }
  if (shellResult.stderr) {
    transcriptChunks.push(`[stderr]\n${shellResult.stderr}`);
  }
  transcriptChunks.push(`[exit] ${shellResult.code}`);
  const transcript = await appendTranscriptToSession(
    sessionId,
    `${transcriptChunks.join("\n\n")}\n`,
    { cwd },
  );

  const shellEvent = await appendEventToSession(
    sessionId,
    {
      type: "shell_command",
      actor,
      summary: summary ?? command,
      command,
      result: {
        exitCode: shellResult.code,
        stdout: shellResult.stdout,
        stderr: shellResult.stderr,
      },
    },
    { cwd },
  );
  events.push(shellEvent);

  let checkpointResult = null;
  if (checkpoint) {
    checkpointResult = await captureSessionCheckpoint(
      sessionId,
      {
        eventType: defaultCheckpointEventType(actor, checkpointEventType),
        actor,
        summary: checkpointSummary ?? summary,
        causedByEventId: shellEvent.id,
      },
      { cwd },
    );
  }

  return {
    events,
    shell: {
      exitCode: shellResult.code,
      stdout: shellResult.stdout,
      stderr: shellResult.stderr,
    },
    transcript,
    checkpoint: checkpointResult,
  };
}

export async function captureSessionCheckpoint(
  sessionId,
  {
    eventType = "file_edit_checkpoint",
    actor,
    summary,
    causedByEventId = null,
  } = {},
  { cwd } = {},
) {
  const session = await readCaptureSession(sessionId, { cwd });
  const snapshot = await snapshotWorktreeTree(session.repo.currentSnapshot, { cwd });
  const patch = await diffRefs(session.repo.currentSnapshot, snapshot, { cwd });

  if (!patch.trim()) {
    return {
      appended: false,
      snapshot,
      files: [],
    };
  }

  session.repo.currentSnapshot = snapshot;
  session.repo.treeFingerprint = snapshot;

  const event = await recordEvent(
    session,
    {
      type: eventType,
      actor: actor
        ?? (eventType === "human_edit" ? "human" : "agent"),
      summary: summary ?? "Captured checkpoint",
      patch,
      causedByEventId,
    },
    cwd,
  );

  return {
    appended: true,
    snapshot,
    files: event.files ?? [],
    event,
  };
}

export async function runTestForSession(
  sessionId,
  command,
  { summary } = {},
  { cwd } = {},
) {
  const session = await readCaptureSession(sessionId, { cwd });
  const result = await runShell(command, { cwd });
  const event = await recordEvent(
    session,
    {
      type: "test_run",
      actor: "agent",
      summary: summary ?? command,
      command,
      result: {
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
      },
    },
    cwd,
  );

  return {
    ...event.result,
    eventId: event.id,
  };
}

export async function finalizeCaptureSession(
  sessionId,
  { targetRef = "HEAD" } = {},
  { cwd } = {},
) {
  let session = await readCaptureSession(sessionId, { cwd });
  const targetCommit = await resolveCommit(targetRef, { cwd });
  const targetTree = await resolveTree(targetCommit, { cwd });

  if (session.repo.currentSnapshot !== targetTree) {
    const patch = await diffRefs(session.repo.currentSnapshot, targetCommit, { cwd });
    if (patch.trim()) {
      session.repo.currentSnapshot = targetTree;
      session.repo.treeFingerprint = targetTree;
      await recordEvent(
        session,
        {
          type: "file_edit_checkpoint",
          actor: "unknown",
          summary: "Finalize uncheckpointed changes",
          patch,
        },
        cwd,
      );
      session = await readCaptureSession(sessionId, { cwd });
    } else {
      session.repo.currentSnapshot = targetTree;
      session.repo.treeFingerprint = targetTree;
      session.metadata.updatedAt = new Date().toISOString();
      await persistSession(session, cwd);
    }
  }

  const events = await readCaptureSessionEvents(sessionId, { cwd });
  const transcriptPath = session.privacy?.rawTranscriptPath;

  const recipe = await normalizeRecipe(
    {
      metadata: {
        recipeId: session.recipeId,
        sourceAgent: session.metadata.sourceAgent,
        adapterVersion: session.metadata.adapterVersion,
        createdAt: session.metadata.createdAt,
        capturedAt: new Date().toISOString(),
      },
      repo: {
        remoteFingerprint: session.repo.remoteFingerprint,
        baseCommit: session.repo.baseCommit,
        targetCommit,
        treeFingerprint: targetTree,
      },
      instructions: session.instructions,
      events,
      outputs: {},
      privacy: {
        redactions: [],
        omittedBlobs: transcriptPath
          ? [
              {
                kind: "raw_transcript",
                storage: "local_only",
                published: false,
                reason: "not_required_for_replay",
              },
            ]
          : [],
        secretScanFindings: [],
      },
    },
    { cwd },
  );

  const stored = await writeRecipeBundle(recipe, { cwd });
  session.finalized = {
    targetCommit,
    recipePath: stored.path,
    recipeSha256: stored.sha256,
    finalizedAt: new Date().toISOString(),
  };
  session.metadata.updatedAt = session.finalized.finalizedAt;
  await persistSession(session, cwd);

  const activeSession = await readActiveSession({ cwd });
  if (activeSession?.sessionId === sessionId) {
    await clearActiveSession({ cwd });
  }

  return {
    sessionId,
    targetCommit,
    stored,
    recipe,
  };
}
