import { writeFileSync } from "node:fs";
import {
  applyEdits,
  findNodeAtLocation,
  modify,
  parse,
  parseTree,
  printParseErrorCode,
} from "jsonc-parser";
import { lineAt, readText } from "./paths.mjs";

/** A UTF-8 byte order mark: tsc and npm accept one at the start; the parser does not. */
const bom = "\uFEFF";

/**
 * Read a config file the way its tool reads it. tsc takes comments and trailing commas in
 * tsconfig.json; package.json and components.json are strict JSON (`strict`).
 * TypeScript 7 ships no JS config reader, so this is jsonc-parser, the JSONC parser VS Code uses.
 * A leading byte order mark is set aside, and kept for a write. A parse error comes back with
 * its line; the caller must then never write the file.
 * @param {string} path - From a check; why: the file to read; a missing file reads as `{}`.
 * @param {{ strict?: boolean }} [options] - From a check; why: strict JSON for npm and shadcn files.
 */
export function readJsonc(path, { strict = false } = {}) {
  const raw = readText(path);
  const marked = raw.startsWith(bom);
  const text = marked ? raw.slice(1) : raw;
  const errors = [];
  const value = parse(text, errors, { allowTrailingComma: !strict, disallowComments: strict });
  if (text && errors.length > 0) {
    const [first] = errors;
    return {
      text,
      marked,
      error: { line: lineAt(text, first.offset), code: printParseErrorCode(first.error) },
    };
  }
  return { text, marked, value: value ?? {} };
}

/**
 * The file's own layout, so a new key reads like its neighbours: the first indent, and CRLF.
 * @param {string} text - From readJsonc; why: the file to copy the layout of.
 */
function layoutOf(text) {
  const indent = text.match(/^([ \t]+)\S/m)?.[1] ?? "  ";
  const tabs = indent.startsWith("\t");
  return {
    insertSpaces: !tabs,
    tabSize: tabs ? 1 : indent.length,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
  };
}

/**
 * @param {string} path - From a --fix; why: the file to write.
 * @param {{ marked: boolean }} read - From readJsonc; why: put a byte order mark back.
 * @param {string} text - From the edit; why: the new text.
 */
function writeBack(path, read, text) {
  writeFileSync(path, `${read.marked ? bom : ""}${text}`);
}

/**
 * Set one key and keep every other byte: comments, order, indent, line ends, and a byte order
 * mark stay. A new key goes first in its object, so no existing line moves.
 * @param {string} path - From a --fix; why: the file to edit in place.
 * @param {{ text: string, marked: boolean }} read - From readJsonc; why: a text that parsed, never a failed parse.
 * @param {string[]} key - From a --fix; why: the path to the key, such as ["scripts", "postinstall"].
 * @param {string} value - From a --fix; why: the value the base owns.
 */
export function writeKey(path, read, key, value) {
  const text = read.text || "{}\n";
  const edits = modify(text, key, value, {
    formattingOptions: layoutOf(text),
    getInsertionIndex: () => 0,
  });
  writeBack(path, read, applyEdits(text, edits));
}

/**
 * Put one file first in tsconfig's `extends` and keep what it already extends: an array gets
 * the entry before its first item; a single file becomes a two-item array. No other byte moves.
 * @param {string} path - From the glue fix; why: the tsconfig.json to edit.
 * @param {{ text: string, marked: boolean }} read - From readJsonc; why: a text that parsed.
 * @param {string} entry - From the glue fix; why: the file the base owns, "./.tinker/tsconfig.json".
 */
export function prependExtends(path, read, entry) {
  const node = findNodeAtLocation(parseTree(read.text, [], { allowTrailingComma: true }), [
    "extends",
  ]);
  if (!node) return writeKey(path, read, ["extends"], entry);
  const quoted = JSON.stringify(entry);
  const [first] = node.children ?? [];
  const old = read.text.slice(node.offset, node.offset + node.length);
  const edit =
    node.type !== "array"
      ? { offset: node.offset, length: node.length, content: `[${quoted}, ${old}]` }
      : {
          offset: first ? first.offset : node.offset + 1,
          length: 0,
          content: first ? `${quoted}, ` : quoted,
        };
  writeBack(path, read, applyEdits(read.text, [edit]));
}

/**
 * The line of a key in a JSONC text, read from the parse tree so a comment never matches.
 * @param {string} text - From readJsonc; why: the text that parsed.
 * @param {(string | number)[]} key - From a check; why: the path to the key.
 */
export function lineOfKey(text, key) {
  const node = findNodeAtLocation(parseTree(text, [], { allowTrailingComma: true }), key);
  return node ? lineAt(text, node.parent.offset) : 1;
}
