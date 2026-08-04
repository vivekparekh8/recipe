/**
 * Public bundle size policy for schema 0.1.
 *
 * Limits are measured per UTF-8 text value after secret redaction. Prompts,
 * summaries, non-test commands, and tool/shell/test metadata are capped at
 * 16 KiB. Replay-critical patches, final diffs, and test commands are never
 * truncated; values above 1 MiB produce an explicit privacy finding instead.
 */
export const PUBLIC_METADATA_TEXT_LIMIT_BYTES = 16 * 1024;
export const REPLAY_CRITICAL_TEXT_WARNING_BYTES = 1024 * 1024;

export function utf8ByteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

export function truncateUtf8(
  value,
  limitBytes = PUBLIC_METADATA_TEXT_LIMIT_BYTES,
  { originalBytes = utf8ByteLength(value) } = {},
) {
  const publishedBytes = utf8ByteLength(value);
  if (publishedBytes <= limitBytes) {
    return {
      value,
      truncated: false,
      originalBytes,
      limitBytes,
      publishedBytes,
    };
  }

  const marker = `\n[TRUNCATED: ${originalBytes} bytes; limit ${limitBytes} bytes]`;
  const contentBudget = limitBytes - utf8ByteLength(marker);
  let prefix = "";
  let prefixBytes = 0;

  for (const character of value) {
    const characterBytes = utf8ByteLength(character);
    if (prefixBytes + characterBytes > contentBudget) {
      break;
    }
    prefix += character;
    prefixBytes += characterBytes;
  }

  const truncatedValue = `${prefix}${marker}`;
  return {
    value: truncatedValue,
    truncated: true,
    originalBytes,
    limitBytes,
    publishedBytes: utf8ByteLength(truncatedValue),
  };
}
