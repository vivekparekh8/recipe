import {
  EVENT_TYPES,
  EVENT_TYPE_VALUES,
  PROVENANCE_STATUSES,
  PROVENANCE_STATUS_VALUES,
  RECIPE_SCHEMA_VERSION,
} from "./constants.js";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const ISO_DATE_TIME_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T";

function stringSchema(extra = {}) {
  return {
    type: "string",
    ...extra,
  };
}

function nullableStringSchema(extra = {}) {
  return {
    anyOf: [
      stringSchema(extra),
      { type: "null" },
    ],
  };
}

function genericObjectSchema(description) {
  return {
    type: "object",
    description,
    additionalProperties: true,
  };
}

function genericArraySchema(description) {
  return {
    type: "array",
    description,
    items: {},
  };
}

function rejectUnknownProperties(value, allowed, path, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      errors.push(`${path}.${key} is not part of schema ${RECIPE_SCHEMA_VERSION}.`);
    }
  }
}

function validateDateTime(value, path, errors) {
  validateString(value, path, errors);
  if (typeof value === "string" && !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    errors.push(`${path} must use ISO date-time form.`);
  }
}

function validateString(value, path, errors, { nullable = false } = {}) {
  if (nullable && value === null) {
    return;
  }
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${path} must be a non-empty string${nullable ? " or null" : ""}.`);
  }
}

function validateOptionalString(value, path, errors) {
  if (value !== undefined) {
    validateString(value, path, errors);
  }
}

function validateOptionalObject(value, path, errors) {
  if (value !== undefined && !isPlainObject(value)) {
    errors.push(`${path} must be an object.`);
  }
}

function validateObjectArray(value, path, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array.`);
    return;
  }
  for (const [index, entry] of value.entries()) {
    if (!isPlainObject(entry)) {
      errors.push(`${path}[${index}] must be an object.`);
    }
  }
}

function validateStringArray(value, path, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array.`);
    return;
  }
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string") {
      errors.push(`${path}[${index}] must be a string.`);
    }
  }
}

export function getRecipeJsonSchema() {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://recipe.dev/schema/recipe-bundle-0.1.0.json",
    title: "recipe bundle",
    type: "object",
    additionalProperties: false,
    required: ["metadata", "repo", "instructions", "events", "outputs", "privacy"],
    properties: {
      metadata: {
        type: "object",
        additionalProperties: false,
        required: [
          "schemaVersion",
          "recipeId",
          "sourceAgent",
          "adapterVersion",
          "createdAt",
          "capturedAt",
          "targetSha256",
        ],
        properties: {
          schemaVersion: {
            const: RECIPE_SCHEMA_VERSION,
          },
          recipeId: stringSchema(),
          sourceAgent: stringSchema(),
          adapterVersion: stringSchema(),
          createdAt: stringSchema({ pattern: ISO_DATE_TIME_PATTERN }),
          capturedAt: stringSchema({ pattern: ISO_DATE_TIME_PATTERN }),
          targetSha256: stringSchema(),
        },
      },
      repo: {
        type: "object",
        additionalProperties: false,
        required: ["remoteFingerprint", "baseCommit", "targetCommit", "treeFingerprint"],
        properties: {
          remoteFingerprint: nullableStringSchema(),
          baseCommit: stringSchema(),
          targetCommit: stringSchema(),
          treeFingerprint: nullableStringSchema(),
        },
      },
      instructions: {
        type: "object",
        additionalProperties: false,
        required: ["prompts", "referencedArtifacts", "promptRevisions"],
        properties: {
          prompts: {
            type: "array",
            items: stringSchema(),
          },
          referencedArtifacts: genericArraySchema("Adapter-specific manifest or artifact references."),
          promptRevisions: {
            type: "array",
            items: genericObjectSchema("Prompt revision metadata."),
          },
        },
      },
      events: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
          required: ["id", "type", "at", "actor", "summary"],
          properties: {
            id: stringSchema(),
            type: {
              enum: EVENT_TYPE_VALUES,
            },
            at: nullableStringSchema({ pattern: ISO_DATE_TIME_PATTERN }),
            actor: nullableStringSchema(),
            summary: nullableStringSchema(),
            command: stringSchema(),
            patch: stringSchema(),
            toolName: stringSchema(),
            inputs: genericObjectSchema("Event inputs."),
            outputs: genericObjectSchema("Event outputs."),
            result: genericObjectSchema("Event result data."),
            files: {
              type: "array",
              items: stringSchema(),
            },
            causedByEventId: stringSchema(),
          },
        },
      },
      outputs: {
        type: "object",
        additionalProperties: false,
        required: ["finalPatch", "touchedFiles", "replayResult", "provenanceStatus"],
        properties: {
          finalPatch: stringSchema(),
          touchedFiles: {
            type: "array",
            items: stringSchema(),
          },
          replayResult: {
            anyOf: [
              { type: "null" },
              genericObjectSchema("Replay result summary."),
            ],
          },
          provenanceStatus: {
            enum: PROVENANCE_STATUS_VALUES,
          },
        },
      },
      privacy: {
        type: "object",
        additionalProperties: false,
        required: ["redactions", "omittedBlobs", "secretScanFindings"],
        properties: {
          redactions: {
            type: "array",
            items: genericObjectSchema("Redaction metadata."),
          },
          omittedBlobs: {
            type: "array",
            items: genericObjectSchema("Locally retained or omitted blobs."),
          },
          secretScanFindings: {
            type: "array",
            items: genericObjectSchema("Secret scan finding metadata."),
          },
        },
      },
    },
  };
}

export function getIngestRecordJsonSchema() {
  const checkpointControls = {
    checkpoint: { type: "boolean" },
    checkpointEventType: stringSchema(),
    checkpointActor: stringSchema(),
    checkpointSummary: stringSchema(),
  };

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://recipe.dev/schema/ingest-record-0.1.0.json",
    title: "recipe ingest record",
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "prompt"],
        properties: {
          kind: { const: "prompt" },
          actor: stringSchema(),
          summary: stringSchema(),
          prompt: stringSchema(),
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "text"],
        properties: {
          kind: { const: "transcript" },
          text: stringSchema(),
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "command"],
        properties: {
          kind: { const: "shell" },
          actor: stringSchema(),
          summary: stringSchema(),
          command: stringSchema(),
          result: genericObjectSchema("Recorded shell result."),
          ...checkpointControls,
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "toolName"],
        properties: {
          kind: { const: "tool" },
          actor: stringSchema(),
          summary: stringSchema(),
          toolName: stringSchema(),
          inputs: genericObjectSchema("Tool inputs."),
          outputs: genericObjectSchema("Tool outputs."),
          ...checkpointControls,
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "command"],
        properties: {
          kind: { const: "test" },
          actor: stringSchema(),
          summary: stringSchema(),
          command: stringSchema(),
          execute: { type: "boolean" },
          result: genericObjectSchema("Recorded test result."),
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind"],
        properties: {
          kind: { const: "checkpoint" },
          actor: stringSchema(),
          summary: stringSchema(),
          eventType: {
            enum: ["file_edit_checkpoint", "human_edit"],
          },
          causedByEventId: stringSchema(),
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "event"],
        properties: {
          kind: { const: "event" },
          event: {
            type: "object",
            additionalProperties: true,
            required: ["type"],
            properties: {
              type: {
                enum: EVENT_TYPE_VALUES,
              },
            },
          },
          ...checkpointControls,
        },
      },
    ],
  };
}

export function getIngestStreamJsonSchema() {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://recipe.dev/schema/ingest-stream-0.1.0.json",
    title: "recipe ingest stream",
    description: "A JSON array form of the line-delimited ingest stream.",
    type: "array",
    items: getIngestRecordJsonSchema(),
  };
}

export function validateRecipe(recipe) {
  const errors = [];

  if (!isPlainObject(recipe)) {
    errors.push("Recipe must be an object.");
    return errors;
  }

  rejectUnknownProperties(
    recipe,
    new Set(["metadata", "repo", "instructions", "events", "outputs", "privacy"]),
    "recipe",
    errors,
  );

  if (!isPlainObject(recipe.metadata)) {
    errors.push("metadata must be an object.");
  } else {
    rejectUnknownProperties(
      recipe.metadata,
      new Set([
        "schemaVersion",
        "recipeId",
        "sourceAgent",
        "adapterVersion",
        "createdAt",
        "capturedAt",
        "targetSha256",
      ]),
      "metadata",
      errors,
    );
    if (recipe.metadata.schemaVersion !== RECIPE_SCHEMA_VERSION) {
      errors.push(`metadata.schemaVersion must equal ${RECIPE_SCHEMA_VERSION}.`);
    }
    for (const field of [
      "recipeId",
      "sourceAgent",
      "adapterVersion",
      "targetSha256",
    ]) {
      validateString(recipe.metadata[field], `metadata.${field}`, errors);
    }
    validateDateTime(recipe.metadata.createdAt, "metadata.createdAt", errors);
    validateDateTime(recipe.metadata.capturedAt, "metadata.capturedAt", errors);
  }

  if (!isPlainObject(recipe.repo)) {
    errors.push("repo must be an object.");
  } else {
    rejectUnknownProperties(
      recipe.repo,
      new Set(["remoteFingerprint", "baseCommit", "targetCommit", "treeFingerprint"]),
      "repo",
      errors,
    );
    validateString(recipe.repo.remoteFingerprint, "repo.remoteFingerprint", errors, { nullable: true });
    validateString(recipe.repo.baseCommit, "repo.baseCommit", errors);
    validateString(recipe.repo.targetCommit, "repo.targetCommit", errors);
    validateString(recipe.repo.treeFingerprint, "repo.treeFingerprint", errors, { nullable: true });
  }

  if (!isPlainObject(recipe.instructions)) {
    errors.push("instructions must be an object.");
  } else {
    rejectUnknownProperties(
      recipe.instructions,
      new Set(["prompts", "referencedArtifacts", "promptRevisions"]),
      "instructions",
      errors,
    );
    validateStringArray(recipe.instructions.prompts, "instructions.prompts", errors);
    if (!Array.isArray(recipe.instructions.referencedArtifacts)) {
      errors.push("instructions.referencedArtifacts must be an array.");
    }
    validateObjectArray(recipe.instructions.promptRevisions, "instructions.promptRevisions", errors);
  }

  if (!Array.isArray(recipe.events)) {
    errors.push("events must be an array.");
  } else {
    for (const [index, event] of recipe.events.entries()) {
      const path = `events[${index}]`;
      if (!isPlainObject(event)) {
        errors.push(`${path} must be an object.`);
        continue;
      }
      validateString(event.id, `${path}.id`, errors);
      if (!EVENT_TYPES.has(event.type)) {
        errors.push(`${path}.type "${event.type}" is not supported.`);
      }
      if (event.at !== null) {
        validateDateTime(event.at, `${path}.at`, errors);
      }
      if (event.actor !== null) {
        validateString(event.actor, `${path}.actor`, errors);
      }
      if (event.summary !== null) {
        validateString(event.summary, `${path}.summary`, errors);
      }
      for (const field of ["command", "patch", "toolName", "causedByEventId"]) {
        validateOptionalString(event[field], `${path}.${field}`, errors);
      }
      for (const field of ["inputs", "outputs", "result"]) {
        validateOptionalObject(event[field], `${path}.${field}`, errors);
      }
      if (event.files !== undefined) {
        validateStringArray(event.files, `${path}.files`, errors);
      }
    }
  }

  if (!isPlainObject(recipe.outputs)) {
    errors.push("outputs must be an object.");
  } else {
    rejectUnknownProperties(
      recipe.outputs,
      new Set(["finalPatch", "touchedFiles", "replayResult", "provenanceStatus"]),
      "outputs",
      errors,
    );
    if (typeof recipe.outputs.finalPatch !== "string") {
      errors.push("outputs.finalPatch must be a string.");
    }
    validateStringArray(recipe.outputs.touchedFiles, "outputs.touchedFiles", errors);
    if (recipe.outputs.replayResult !== null && !isPlainObject(recipe.outputs.replayResult)) {
      errors.push("outputs.replayResult must be an object or null.");
    }
    if (!PROVENANCE_STATUSES.has(recipe.outputs.provenanceStatus)) {
      errors.push("outputs.provenanceStatus is invalid.");
    }
  }

  if (!isPlainObject(recipe.privacy)) {
    errors.push("privacy must be an object.");
  } else {
    rejectUnknownProperties(
      recipe.privacy,
      new Set(["redactions", "omittedBlobs", "secretScanFindings"]),
      "privacy",
      errors,
    );
    validateObjectArray(recipe.privacy.redactions, "privacy.redactions", errors);
    validateObjectArray(recipe.privacy.omittedBlobs, "privacy.omittedBlobs", errors);
    validateObjectArray(recipe.privacy.secretScanFindings, "privacy.secretScanFindings", errors);
  }

  return errors;
}

export function assertValidRecipe(recipe) {
  const errors = validateRecipe(recipe);
  if (errors.length > 0) {
    throw new Error(`Invalid recipe:\n- ${errors.join("\n- ")}`);
  }
}

export function validateIngestRecord(record, index = 0) {
  const errors = [];

  if (!isPlainObject(record)) {
    errors.push(`Record ${index + 1} must be an object.`);
    return errors;
  }

  const kind = record.kind;
  if (!kind) {
    errors.push(`Record ${index + 1} is missing "kind".`);
    return errors;
  }

  const common = new Set(["kind", "actor", "summary"]);
  const checkpointControls = [
    "checkpoint",
    "checkpointEventType",
    "checkpointActor",
    "checkpointSummary",
  ];
  const allowedByKind = {
    prompt: new Set([...common, "prompt"]),
    transcript: new Set(["kind", "text"]),
    shell: new Set([...common, "command", "result", ...checkpointControls]),
    tool: new Set([...common, "toolName", "inputs", "outputs", ...checkpointControls]),
    test: new Set([...common, "command", "execute", "result"]),
    checkpoint: new Set([...common, "eventType", "causedByEventId"]),
    event: new Set(["kind", "event", ...checkpointControls]),
  };

  if (!allowedByKind[kind]) {
    errors.push(`Record ${index + 1} kind "${kind}" is not supported.`);
    return errors;
  }
  rejectUnknownProperties(record, allowedByKind[kind], `Record ${index + 1}`, errors);

  for (const field of ["actor", "summary", "checkpointEventType", "checkpointActor", "checkpointSummary"] ) {
    validateOptionalString(record[field], `Record ${index + 1}.${field}`, errors);
  }
  if (record.checkpoint !== undefined && typeof record.checkpoint !== "boolean") {
    errors.push(`Record ${index + 1}.checkpoint must be a boolean.`);
  }

  if (kind === "prompt") {
    if (typeof record.prompt !== "string" || record.prompt.length === 0) {
      errors.push(`Record ${index + 1} prompt records require "prompt".`);
    }
    return errors;
  }

  if (kind === "transcript") {
    if (typeof record.text !== "string" || record.text.length === 0) {
      errors.push(`Record ${index + 1} transcript records require "text".`);
    }
    return errors;
  }

  if (kind === "shell") {
    if (typeof record.command !== "string" || record.command.length === 0) {
      errors.push(`Record ${index + 1} shell records require "command".`);
    }
    validateOptionalObject(record.result, `Record ${index + 1}.result`, errors);
    return errors;
  }

  if (kind === "tool") {
    if (typeof record.toolName !== "string" || record.toolName.length === 0) {
      errors.push(`Record ${index + 1} tool records require "toolName".`);
    }
    validateOptionalObject(record.inputs, `Record ${index + 1}.inputs`, errors);
    validateOptionalObject(record.outputs, `Record ${index + 1}.outputs`, errors);
    return errors;
  }

  if (kind === "test") {
    if (typeof record.command !== "string" || record.command.length === 0) {
      errors.push(`Record ${index + 1} test records require "command".`);
    }
    if (record.execute !== undefined && typeof record.execute !== "boolean") {
      errors.push(`Record ${index + 1}.execute must be a boolean.`);
    }
    validateOptionalObject(record.result, `Record ${index + 1}.result`, errors);
    return errors;
  }

  if (kind === "checkpoint") {
    if (record.eventType && !["file_edit_checkpoint", "human_edit"].includes(record.eventType)) {
      errors.push(`Record ${index + 1} checkpoint eventType must be file_edit_checkpoint or human_edit.`);
    }
    validateOptionalString(record.causedByEventId, `Record ${index + 1}.causedByEventId`, errors);
    return errors;
  }

  if (kind === "event") {
    if (!isPlainObject(record.event)) {
      errors.push(`Record ${index + 1} event records require an "event" object.`);
      return errors;
    }
    if (!EVENT_TYPES.has(record.event.type)) {
      errors.push(`Record ${index + 1} event.type is invalid.`);
    }
    return errors;
  }
}

export function validateIngestRecords(records) {
  const errors = [];
  if (!Array.isArray(records)) {
    return ["Ingest input must be an array of records."];
  }

  for (const [index, record] of records.entries()) {
    errors.push(...validateIngestRecord(record, index));
  }

  return errors;
}
