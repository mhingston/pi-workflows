/**
 * Textareas display CRLF and CR as LF; workflow.ts source bytes remain
 * authoritative. Never use the textarea's normalized value as source directly.
 */
export function displaySource(source) {
  return source.replace(/\r\n?|\n/g, "\n");
}

function splitSourceLines(source) {
  const lines = [];
  const re = /\r\n|\r|\n/g;
  let start = 0, match;
  while ((match = re.exec(source)) !== null) {
    lines.push({ text: source.slice(start, match.index), ending: match[0] });
    start = match.index + match[0].length;
  }
  lines.push({ text: source.slice(start), ending: "" });
  return lines;
}

/**
 * Align surviving lines to their original endings. Insertion/deletion shifts
 * lines; simple index-based EOL replacement would otherwise corrupt the EOLs
 * of untouched lines in mixed-ending documents.
 */
function alignLines(before, after) {
  const n = before.length, m = after.length;
  const positions = Array(m).fill(-1);
  // Prefer safe failure over a memory-intensive O(n*m) edit on very large files.
  if (n * m > 1_000_000) {
    if (n !== m) throw new Error("Too many lines to safely remap inserted/deleted lines; edit a smaller region.");
    for (let i = 0; i < m; i++) positions[i] = i;
    return positions;
  }
  const rows = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      rows[i][j] = before[i] === after[j] ? rows[i + 1][j + 1] + 1 :
        Math.max(rows[i + 1][j], rows[i][j + 1]);
    }
  }
  const anchors = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      anchors.push([i, j]);
      i++; j++;
    } else if (rows[i + 1][j] >= rows[i][j + 1]) i++;
    else j++;
  }
  anchors.push([n, m]);
  let previousOld = -1, previousNew = -1;
  for (const [oldIndex, newIndex] of anchors) {
    // Modified lines between LCS anchors inherit the EOL of the corresponding
    // original line; truly inserted lines use their nearest surviving neighbor.
    for (let k = previousNew + 1; k < newIndex; k++) {
      const paired = previousOld + 1 + k - (previousNew + 1);
      if (paired < oldIndex) positions[k] = paired;
    }
    if (newIndex < m) positions[newIndex] = oldIndex;
    previousOld = oldIndex;
    previousNew = newIndex;
  }
  return positions;
}

export function sourceFromTextarea(original, textareaValue) {
  const edited = displaySource(textareaValue);
  if (displaySource(original) === edited) return original;

  const old = splitSourceLines(original);
  const next = edited.split("\n");
  const mapped = alignLines(old.map(line => line.text), next);
  const nearestEnding = (index) => {
    for (let i = index - 1; i >= 0; i--) {
      if (mapped[i] >= 0 && old[mapped[i]].ending) return old[mapped[i]].ending;
    }
    for (let i = index + 1; i < mapped.length; i++) {
      if (mapped[i] >= 0 && old[mapped[i]].ending) return old[mapped[i]].ending;
    }
    return old.find(line => line.ending)?.ending ?? "\n";
  };
  return next.map((line, index) => {
    if (index === next.length - 1) return line;
    const previous = mapped[index] >= 0 ? old[mapped[index]].ending : "";
    return line + (previous || nearestEnding(index));
  }).join("");
}
