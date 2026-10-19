import assert from "node:assert/strict";
import test from "node:test";
import { displaySource, sourceFromTextarea } from "../ui/source-text.js";

test("textarea normalization leaves CRLF source byte-for-byte unchanged on no-op", () => {
  const source = "const a = 1;\r\n// 🎵 café\r\nconst b = 2;\r\n";
  assert.equal(displaySource(source), "const a = 1;\n// 🎵 café\nconst b = 2;\n");
  assert.equal(sourceFromTextarea(source, displaySource(source)), source);
});

test("single code edit preserves untouched mixed CRLF, LF and CR line endings", () => {
  const source = "alpha\r\nbeta\ncharlie\rdelta\r\n";
  const edit = "alpha\nBETA\ncharlie\ndelta\n";
  assert.equal(sourceFromTextarea(source, edit), "alpha\r\nBETA\ncharlie\rdelta\r\n");
});

test("new lines use neighboring line ending without normalizing unchanged source", () => {
  const source = "alpha\r\nbeta\ncharlie\r\n";
  assert.equal(
    sourceFromTextarea(source, "alpha\ninserted\nbeta\ncharlie\n"),
    "alpha\r\ninserted\r\nbeta\ncharlie\r\n",
  );
});

test("source editing preserves unicode around a replacement", () => {
  const source = "// 🍃 naïve\r\nconst name = 'a';\r\n";
  assert.equal(
    sourceFromTextarea(source, "// 🍃 naïve\nconst name = 'λ';\n"),
    "// 🍃 naïve\r\nconst name = 'λ';\r\n",
  );
});


test("multiple separate source edits keep every unrelated mixed line ending", () => {
  const source = "alpha\r\nbeta\ncharlie\rdelta\r\n";
  assert.equal(
    sourceFromTextarea(source, "ALPHA\nbeta\ncharlie\nDELTA\n"),
    "ALPHA\r\nbeta\ncharlie\rDELTA\r\n",
  );
});

test("insert and remove lines without changing the EOL style of surviving lines", () => {
  const source = "alpha\r\nbeta\ncharlie\r\n";
  assert.equal(
    sourceFromTextarea(source, "alpha\ninserted\ncharlie\n"),
    "alpha\r\ninserted\r\ncharlie\r\n",
  );
});
