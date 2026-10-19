/**
 * Browsers normalize textarea line endings to LF. Keep the authoritative
 * source bytes instead of treating the displayed value as source text.
 */
export function displaySource(source) {
  return source.replace(/\r\n?|\n/g, "\n");
}

/** Return the UTF-16 offset in the original source for a normalized boundary. */
function sourceOffset(source, normalizedIndex) {
  let normalized = 0;
  for (let offset = 0; offset < source.length; offset++) {
    if (normalized === normalizedIndex) return offset;
    if (source[offset] === "\r" && source[offset + 1] === "\n") offset++;
    normalized++;
  }
  if (normalized === normalizedIndex) return source.length;
  throw new Error("invalid normalized source offset");
}

function lineEndingNear(source, start, end) {
  const replaced = source.slice(start, end).match(/\r\n|\r|\n/);
  if (replaced) return replaced[0];
  const previous = source.slice(0, start).match(/\r\n|\r|\n/g);
  if (previous?.length) return previous[previous.length - 1];
  return source.slice(end).match(/\r\n|\r|\n/)?.[0] ?? "\n";
}

/**
 * Change only a bounded span relative to the normalized textarea value.
 * No typing => exact original bytes. Outside the changed span, preserve every
 * original line ending, including mixed CRLF/LF documents.
 */
export function sourceFromTextarea(original, textareaValue) {
  const before = displaySource(original);
  const after = displaySource(textareaValue);
  if (before === after) return original;
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix &&
         before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const start = sourceOffset(original, prefix);
  const end = sourceOffset(original, before.length - suffix);
  const replacement = after.slice(prefix, after.length - suffix)
    .replace(/\n/g, lineEndingNear(original, start, end));
  return original.slice(0, start) + replacement + original.slice(end);
}
