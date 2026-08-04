function extractTouchedFiles(patchText) {
  const files = [];
  const lines = patchText.split(/\r?\n/);

  for (const line of lines) {
    if (line.startsWith("+++ b/")) {
      files.push(line.slice("+++ b/".length));
    }
  }

  return [...new Set(files.filter(Boolean))];
}

export function isCausalAction(event) {
  return event.type === "prompt"
    || event.type === "tool_call"
    || event.type === "shell_command"
    || event.type === "approval";
}

export function buildEventContext(events) {
  const eventById = new Map();
  const latestPromptBeforeEventId = new Map();
  const inferredCauseByEventId = new Map();
  let latestPromptId = null;
  let latestActionId = null;

  for (const event of events) {
    eventById.set(event.id, event);
    latestPromptBeforeEventId.set(event.id, latestPromptId);

    if ((event.type === "file_edit_checkpoint" || event.type === "human_edit")
      && !event.causedByEventId
      && latestActionId) {
      inferredCauseByEventId.set(event.id, latestActionId);
    }

    if (event.type === "prompt") {
      latestPromptId = event.id;
    }

    if (isCausalAction(event)) {
      latestActionId = event.id;
    }
  }

  return {
    eventById,
    latestPromptBeforeEventId,
    inferredCauseByEventId,
  };
}

export function resolveCause(event, context) {
  const causeEventId = event.causedByEventId ?? context.inferredCauseByEventId.get(event.id) ?? null;
  if (!causeEventId) {
    return { event: null, prompt: null };
  }

  const causeEvent = context.eventById.get(causeEventId) ?? null;
  if (!causeEvent) {
    return { event: null, prompt: null };
  }

  const promptEventId = context.latestPromptBeforeEventId.get(causeEvent.id) ?? null;
  const promptEvent = promptEventId
    ? context.eventById.get(promptEventId) ?? null
    : null;

  return {
    event: causeEvent,
    prompt: promptEvent,
  };
}

function promptText(event) {
  return event?.inputs?.prompt ?? event?.summary ?? null;
}

function eventText(event) {
  return event?.summary ?? event?.command ?? event?.toolName ?? null;
}

function unionFiles(existingFiles, nextFiles) {
  return [...new Set([...existingFiles, ...nextFiles])];
}

export function buildProvenanceTimeline(events) {
  const context = buildEventContext(events);
  const steps = [];
  const stepById = new Map();
  const stepByActionEventId = new Map();
  const promptUsedByStep = new Set();
  let pendingPromptId = null;
  let latestStepId = null;

  function createStep({
    kind,
    promptEvent = null,
    actionEvent = null,
    anchorEvent = null,
  }) {
    const step = {
      id: `step-${steps.length + 1}`,
      ordinal: steps.length + 1,
      kind,
      promptEventId: promptEvent?.id ?? null,
      promptSummary: promptText(promptEvent),
      actionEventId: actionEvent?.id ?? null,
      actionType: actionEvent?.type ?? null,
      actionSummary: eventText(actionEvent),
      actionCommand: actionEvent?.command ?? null,
      actionResult: actionEvent?.result ?? null,
      anchorEventId: anchorEvent?.id ?? actionEvent?.id ?? promptEvent?.id ?? null,
      eventIds: [],
      checkpoints: [],
      tests: [],
      touchedFiles: [],
    };

    if (promptEvent) {
      promptUsedByStep.add(promptEvent.id);
      if (pendingPromptId === promptEvent.id) {
        pendingPromptId = null;
      }
    }

    if (actionEvent) {
      step.eventIds.push(actionEvent.id);
      stepByActionEventId.set(actionEvent.id, step);
    } else if (anchorEvent) {
      step.eventIds.push(anchorEvent.id);
    }

    steps.push(step);
    stepById.set(step.id, step);
    latestStepId = step.id;
    return step;
  }

  function latestPromptForEvent(event) {
    const promptEventId = context.latestPromptBeforeEventId.get(event.id) ?? null;
    return promptEventId ? context.eventById.get(promptEventId) ?? null : null;
  }

  function ensurePromptStep(promptEvent) {
    if (!promptEvent || promptUsedByStep.has(promptEvent.id)) {
      return null;
    }
    return createStep({
      kind: "prompt",
      promptEvent,
      anchorEvent: promptEvent,
    });
  }

  for (const event of events) {
    if (event.type === "prompt") {
      if (pendingPromptId) {
        ensurePromptStep(context.eventById.get(pendingPromptId) ?? null);
      }
      pendingPromptId = event.id;
      latestStepId = null;
      continue;
    }

    if (event.type === "shell_command" || event.type === "tool_call" || event.type === "approval") {
      const promptEvent = latestPromptForEvent(event);
      createStep({
        kind: "action",
        promptEvent,
        actionEvent: event,
      });
      continue;
    }

    if (event.type === "file_edit_checkpoint" || event.type === "human_edit") {
      const cause = resolveCause(event, context);
      const files = event.files?.length ? event.files : extractTouchedFiles(event.patch ?? "");
      let step = cause.event ? stepByActionEventId.get(cause.event.id) ?? null : null;

      if (!step && latestStepId) {
        step = stepById.get(latestStepId) ?? null;
      }

      if (!step) {
        step = createStep({
          kind: "checkpoint",
          promptEvent: cause.prompt ?? latestPromptForEvent(event),
          anchorEvent: event,
        });
      }

      step.eventIds.push(event.id);
      step.checkpoints.push({
        id: event.id,
        type: event.type,
        summary: eventText(event),
        files,
        patch: event.patch ?? null,
      });
      step.touchedFiles = unionFiles(step.touchedFiles, files);
      latestStepId = step.id;
      continue;
    }

    if (event.type === "test_run") {
      let step = latestStepId ? stepById.get(latestStepId) ?? null : null;
      if (!step) {
        step = createStep({
          kind: "test",
          promptEvent: latestPromptForEvent(event),
          anchorEvent: event,
        });
      }

      step.eventIds.push(event.id);
      step.tests.push({
        id: event.id,
        type: event.type,
        summary: eventText(event),
        command: event.command ?? null,
        exitCode: event.result?.exitCode ?? null,
      });
      latestStepId = step.id;
      continue;
    }
  }

  if (pendingPromptId) {
    ensurePromptStep(context.eventById.get(pendingPromptId) ?? null);
  }

  return steps;
}

function compactText(value) {
  if (!value) {
    return null;
  }
  return value.trim().replace(/\s+/g, " ");
}

function formatActionLine(step) {
  if (!step.actionEventId) {
    if (step.kind === "prompt") {
      return "prompt only";
    }
    if (step.kind === "checkpoint") {
      return "checkpoint only";
    }
    if (step.kind === "test") {
      return "test only";
    }
    return step.kind;
  }

  const detail = compactText(step.actionSummary) ?? "(no summary)";
  return `${step.actionType} (${step.actionEventId}) :: ${detail}`;
}

function formatCheckpointLine(checkpoint) {
  const detail = compactText(checkpoint.summary) ?? "(no summary)";
  const files = checkpoint.files.length ? checkpoint.files.join(", ") : "(none)";
  return `${checkpoint.type} (${checkpoint.id}) :: ${detail} [${files}]`;
}

function formatTestLine(test) {
  const detail = compactText(test.summary ?? test.command) ?? "(no summary)";
  const suffix = test.exitCode === null ? "" : ` -> exit ${test.exitCode}`;
  return `${detail}${suffix}`;
}

export function renderProvenanceTimelineMarkdown(steps) {
  if (steps.length === 0) {
    return "_No provenance steps captured._";
  }

  return steps.map((step) => {
    const lines = [`### Step ${step.ordinal}`];
    if (step.promptSummary) {
      lines.push(`- prompt: ${compactText(step.promptSummary)}`);
    }
    lines.push(`- action: ${formatActionLine(step)}`);
    if (step.touchedFiles.length) {
      lines.push(`- files: ${step.touchedFiles.join(", ")}`);
    }
    for (const checkpoint of step.checkpoints) {
      lines.push(`- checkpoint: ${formatCheckpointLine(checkpoint)}`);
    }
    for (const test of step.tests) {
      lines.push(`- test: ${formatTestLine(test)}`);
    }
    return lines.join("\n");
  }).join("\n\n");
}

export function renderProvenanceTimelineText(steps) {
  if (steps.length === 0) {
    return "No provenance steps captured.";
  }

  return steps.map((step) => {
    const lines = [`  ${step.ordinal}. ${formatActionLine(step)}`];
    if (step.promptSummary) {
      lines.push(`     prompt: ${compactText(step.promptSummary)}`);
    }
    if (step.touchedFiles.length) {
      lines.push(`     files:  ${step.touchedFiles.join(", ")}`);
    }
    for (const checkpoint of step.checkpoints) {
      lines.push(`     checkpoint: ${formatCheckpointLine(checkpoint)}`);
    }
    for (const test of step.tests) {
      lines.push(`     test: ${formatTestLine(test)}`);
    }
    return lines.join("\n");
  }).join("\n");
}
