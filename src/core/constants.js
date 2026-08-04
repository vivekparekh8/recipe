export const RECIPE_SCHEMA_VERSION = "0.1.0";

export const EVENT_TYPE_VALUES = [
  "prompt",
  "tool_call",
  "shell_command",
  "file_edit_checkpoint",
  "test_run",
  "approval",
  "human_edit",
];

export const EVENT_TYPES = new Set(EVENT_TYPE_VALUES);

export const PROVENANCE_STATUS_VALUES = [
  "pure_ai",
  "ai_plus_human",
  "manual_override",
  "unknown",
];

export const PROVENANCE_STATUSES = new Set(PROVENANCE_STATUS_VALUES);
