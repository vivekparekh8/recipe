import {
  PUBLIC_METADATA_TEXT_LIMIT_BYTES,
  REPLAY_CRITICAL_TEXT_WARNING_BYTES,
  truncateUtf8,
  utf8ByteLength,
} from "./limits.js";

const SECRET_PATTERNS = [
  {
    id: "openai_api_key",
    regex: /\bsk-[A-Za-z0-9_\-]{16,}\b/g,
  },
  {
    id: "github_pat",
    regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  },
  {
    id: "github_token",
    regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  },
  {
    id: "aws_access_key",
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    id: "slack_token",
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: "bearer_token",
    regex: /\bBearer\s+[A-Za-z0-9._\-]{16,}\b/g,
  },
  {
    id: "private_key",
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
];

function clonePattern(pattern) {
  return new RegExp(pattern.source, pattern.flags);
}

function stringifyPath(pathSegments) {
  return pathSegments.reduce((accumulator, segment, index) => {
    if (typeof segment === "number") {
      return `${accumulator}[${segment}]`;
    }
    if (index === 0) {
      return segment;
    }
    return `${accumulator}.${segment}`;
  }, "");
}

function sanitizeString(value, pathString, { replayCritical }, findings, redactions) {
  let next = value;
  let changed = false;
  const originalBytes = utf8ByteLength(value);

  for (const pattern of SECRET_PATTERNS) {
    const regex = clonePattern(pattern.regex);
    const matches = [...value.matchAll(regex)];
    if (matches.length === 0) {
      continue;
    }

    findings.push({
      path: pathString,
      matcher: pattern.id,
      count: matches.length,
      action: replayCritical ? "preserved_replay_critical" : "redacted",
      replayCritical,
    });

    if (!replayCritical) {
      changed = true;
      const replacement = `[REDACTED:${pattern.id}]`;
      const replaceRegex = clonePattern(pattern.regex);
      next = next.replace(replaceRegex, replacement);
      redactions.push({
        path: pathString,
        matcher: pattern.id,
        count: matches.length,
        replacement,
      });
    }
  }

  const redactedValue = changed ? next : value;
  if (replayCritical) {
    if (originalBytes > REPLAY_CRITICAL_TEXT_WARNING_BYTES) {
      findings.push({
        path: pathString,
        matcher: "size_limit",
        kind: "oversize_replay_critical",
        action: "preserved_oversize_replay_critical",
        replayCritical: true,
        originalBytes,
        limitBytes: REPLAY_CRITICAL_TEXT_WARNING_BYTES,
        unit: "utf8_bytes",
      });
    }
    return redactedValue;
  }

  const limited = truncateUtf8(
    redactedValue,
    PUBLIC_METADATA_TEXT_LIMIT_BYTES,
    { originalBytes },
  );
  if (limited.truncated) {
    redactions.push({
      path: pathString,
      matcher: "size_limit",
      action: "truncated",
      originalBytes: limited.originalBytes,
      limitBytes: limited.limitBytes,
      publishedBytes: limited.publishedBytes,
      unit: "utf8_bytes",
    });
  }

  return limited.value;
}

function sanitizeValue(value, pathSegments, options, findings, redactions) {
  if (typeof value === "string") {
    return sanitizeString(
      value,
      stringifyPath(pathSegments),
      options,
      findings,
      redactions,
    );
  }

  if (Array.isArray(value)) {
    return value.map((entry, index) => sanitizeValue(
      entry,
      [...pathSegments, index],
      options,
      findings,
      redactions,
    ));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        sanitizeValue(entry, [...pathSegments, key], options, findings, redactions),
      ]),
    );
  }

  return value;
}

function sanitizeEvent(event, index, findings, redactions) {
  const path = ["events", index];
  const sanitized = {
    ...event,
  };

  if (typeof sanitized.summary === "string") {
    sanitized.summary = sanitizeValue(
      sanitized.summary,
      [...path, "summary"],
      { replayCritical: false },
      findings,
      redactions,
    );
  }

  if (typeof sanitized.command === "string") {
    sanitized.command = sanitizeValue(
      sanitized.command,
      [...path, "command"],
      { replayCritical: event.type === "test_run" },
      findings,
      redactions,
    );
  }

  if (typeof sanitized.toolName === "string") {
    sanitized.toolName = sanitizeValue(
      sanitized.toolName,
      [...path, "toolName"],
      { replayCritical: false },
      findings,
      redactions,
    );
  }

  if (typeof sanitized.patch === "string") {
    sanitized.patch = sanitizeValue(
      sanitized.patch,
      [...path, "patch"],
      { replayCritical: true },
      findings,
      redactions,
    );
  }

  if (sanitized.inputs !== undefined) {
    sanitized.inputs = sanitizeValue(
      sanitized.inputs,
      [...path, "inputs"],
      { replayCritical: false },
      findings,
      redactions,
    );
  }

  if (sanitized.outputs !== undefined) {
    sanitized.outputs = sanitizeValue(
      sanitized.outputs,
      [...path, "outputs"],
      { replayCritical: false },
      findings,
      redactions,
    );
  }

  if (sanitized.result !== undefined) {
    sanitized.result = sanitizeValue(
      sanitized.result,
      [...path, "result"],
      { replayCritical: false },
      findings,
      redactions,
    );
  }

  return sanitized;
}

function sanitizeOmittedBlob(blob) {
  if (!blob || blob.kind !== "raw_transcript") {
    return blob;
  }

  return {
    kind: "raw_transcript",
    storage: "local_only",
    published: false,
    reason: "not_required_for_replay",
  };
}

export function sanitizeDraftPrivacy(draft) {
  const findings = [];
  const redactions = [];

  const sanitized = {
    ...draft,
    instructions: {
      prompts: sanitizeValue(
        draft.instructions?.prompts ?? [],
        ["instructions", "prompts"],
        { replayCritical: false },
        findings,
        redactions,
      ),
      referencedArtifacts: sanitizeValue(
        draft.instructions?.referencedArtifacts ?? [],
        ["instructions", "referencedArtifacts"],
        { replayCritical: false },
        findings,
        redactions,
      ),
      promptRevisions: sanitizeValue(
        draft.instructions?.promptRevisions ?? [],
        ["instructions", "promptRevisions"],
        { replayCritical: false },
        findings,
        redactions,
      ),
    },
    events: (draft.events ?? []).map((event, index) => sanitizeEvent(
      event,
      index,
      findings,
      redactions,
    )),
    outputs: {
      ...draft.outputs,
      finalPatch: draft.outputs?.finalPatch !== undefined
        ? sanitizeValue(
          draft.outputs.finalPatch,
          ["outputs", "finalPatch"],
          { replayCritical: true },
          findings,
          redactions,
        )
        : draft.outputs?.finalPatch,
    },
    privacy: {
      redactions: [
        ...(draft.privacy?.redactions ?? []),
        ...redactions,
      ],
      omittedBlobs: (draft.privacy?.omittedBlobs ?? []).map(sanitizeOmittedBlob),
      secretScanFindings: [
        ...(draft.privacy?.secretScanFindings ?? []),
        ...findings,
      ],
    },
  };

  return {
    draft: sanitized,
    redactions,
    findings,
  };
}
