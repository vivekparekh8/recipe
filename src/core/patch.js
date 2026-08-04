import { buildEventContext, resolveCause } from "./provenance.js";

function parseHunkHeader(line) {
  const match = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) {
    return null;
  }

  return {
    oldStart: Number(match[1]),
    oldCount: Number(match[2] ?? 1),
    newStart: Number(match[3]),
    newCount: Number(match[4] ?? 1),
  };
}

export function parseUnifiedDiff(patchText) {
  const files = [];
  const lines = patchText.split(/\r?\n/);
  let currentFile = null;
  let currentHunk = null;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (currentFile) {
        files.push(currentFile);
      }
      const paths = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      currentFile = {
        oldPath: paths?.[1] ?? null,
        path: paths?.[2] ?? null,
        hunks: [],
        binary: false,
      };
      currentHunk = null;
      continue;
    }

    if (line.startsWith("--- a/") && currentFile) {
      currentFile.oldPath = line.slice("--- a/".length);
      continue;
    }

    if (line === "--- /dev/null" && currentFile) {
      currentFile.oldPath = null;
      continue;
    }

    if (line.startsWith("+++ b/") && currentFile) {
      currentFile.path = line.slice("+++ b/".length);
      continue;
    }

    if (line === "+++ /dev/null" && currentFile) {
      currentFile.path = null;
      continue;
    }

    if (line.startsWith("rename from ") && currentFile) {
      currentFile.oldPath = line.slice("rename from ".length);
      continue;
    }

    if (line.startsWith("rename to ") && currentFile) {
      currentFile.path = line.slice("rename to ".length);
      continue;
    }

    if ((line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) && currentFile) {
      currentFile.binary = true;
      continue;
    }

    if (line.startsWith("@@") && currentFile) {
      const header = parseHunkHeader(line);
      if (!header) {
        continue;
      }
      currentHunk = {
        ...header,
        lines: [],
      };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    if (currentHunk && /^[ +\-]/.test(line)) {
      currentHunk.lines.push(line);
    }
  }

  if (currentFile) {
    files.push(currentFile);
  }

  return files.filter((file) => file.path || file.oldPath);
}

export function extractTouchedFiles(patchText) {
  return [...new Set(
    parseUnifiedDiff(patchText)
      .map((file) => file.path ?? file.oldPath)
      .filter(Boolean),
  )];
}

function attributionRecord(event, cause) {
  return {
    eventId: event.id,
    eventType: event.type,
    causeEventId: cause.event?.id ?? null,
    causeEventType: cause.event?.type ?? null,
    causeSummary: cause.event?.summary ?? cause.event?.command ?? null,
    promptEventId: cause.prompt?.id ?? null,
    promptSummary: cause.prompt?.inputs?.prompt ?? cause.prompt?.summary ?? null,
    attributionKind: "added_line",
    coordinateSpace: "final_tree",
  };
}

function hunkOldToNewLines(hunk) {
  const survivingLines = new Map();
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;

  for (const line of hunk.lines) {
    if (line.startsWith(" ")) {
      survivingLines.set(oldLine, newLine);
      oldLine += 1;
      newLine += 1;
    } else if (line.startsWith("-")) {
      oldLine += 1;
    } else if (line.startsWith("+")) {
      newLine += 1;
    }
  }

  return survivingLines;
}

function mapOldLineToNew(oldLine, hunks) {
  let delta = 0;

  for (const hunk of hunks) {
    if (oldLine < hunk.oldStart) {
      return oldLine + delta;
    }

    if (hunk.oldCount === 0 && oldLine <= hunk.oldStart) {
      return oldLine + delta;
    }

    if (hunk.oldCount === 0) {
      delta += hunk.newCount;
      continue;
    }

    const oldEnd = hunk.oldStart + hunk.oldCount - 1;
    if (oldLine <= oldEnd) {
      return hunkOldToNewLines(hunk).get(oldLine) ?? null;
    }

    delta += hunk.newCount - hunk.oldCount;
  }

  return oldLine + delta;
}

function transformExistingLines(lines, hunks) {
  const transformed = new Map();
  for (const [lineNumber, record] of lines) {
    const mappedLine = mapOldLineToNew(lineNumber, hunks);
    if (mappedLine !== null) {
      transformed.set(mappedLine, record);
    }
  }
  return transformed;
}

function addCurrentLines(lines, hunks, record) {
  for (const hunk of hunks) {
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.startsWith("+")) {
        lines.set(newLine, record);
        newLine += 1;
      } else if (line.startsWith(" ")) {
        newLine += 1;
      }
    }
  }
}

function sameAttribution(left, right) {
  return left.eventId === right.eventId
    && left.causeEventId === right.causeEventId
    && left.promptEventId === right.promptEventId;
}

function compactLineAttribution(lines) {
  const sorted = [...lines.entries()].sort(([left], [right]) => left - right);
  const ranges = [];

  for (const [lineNumber, record] of sorted) {
    const previous = ranges.at(-1);
    if (previous
      && previous.end + 1 === lineNumber
      && sameAttribution(previous, record)) {
      previous.end = lineNumber;
      continue;
    }

    ranges.push({
      ...record,
      start: lineNumber,
      end: lineNumber,
    });
  }

  return ranges;
}

export function buildAttributionIndex(events) {
  const linesByFile = new Map();
  const context = buildEventContext(events);

  for (const event of events) {
    if ((event.type !== "file_edit_checkpoint" && event.type !== "human_edit") || !event.patch) {
      continue;
    }

    const cause = resolveCause(event, context);
    const record = attributionRecord(event, cause);
    const parsed = parseUnifiedDiff(event.patch);
    for (const file of parsed) {
      if (file.oldPath && file.path && file.oldPath !== file.path) {
        const renamedLines = linesByFile.get(file.oldPath) ?? new Map();
        linesByFile.delete(file.oldPath);
        linesByFile.set(file.path, renamedLines);
      }

      if (!file.path) {
        linesByFile.delete(file.oldPath);
        continue;
      }

      if (file.binary) {
        linesByFile.delete(file.path);
        continue;
      }

      const existing = linesByFile.get(file.path) ?? new Map();
      const transformed = transformExistingLines(existing, file.hunks);
      addCurrentLines(transformed, file.hunks, record);
      linesByFile.set(file.path, transformed);
    }
  }

  const attribution = new Map();
  for (const [filePath, lines] of linesByFile) {
    const ranges = compactLineAttribution(lines);
    if (ranges.length > 0) {
      attribution.set(filePath, ranges);
    }
  }
  return attribution;
}

export function findAttributionForLine(attribution, filePath, lineNumber) {
  const ranges = attribution.get(filePath) ?? [];
  return ranges.find((range) => lineNumber >= range.start && lineNumber <= range.end) ?? null;
}
