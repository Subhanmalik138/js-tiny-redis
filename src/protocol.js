'use strict';

/**
 * Tiny line-based wire protocol.
 *
 * Request:  COMMAND arg1 "quoted arg 2" arg3\r\n
 *   - tokens are split on whitespace; double quotes group tokens and support
 *     \" and \\ escapes. Commands are case-insensitive.
 * Response: one JSON value per line, e.g. "OK"\n, 42\n, null\n, ["a","b"]\n
 *   - errors are {"error": "<message>"} so the client can print ERR lines.
 */

/** Split a command line into tokens, honoring double quotes. */
function parseLine(line) {
  const tokens = [];
  let current = '';
  let inToken = false;   // we have started a token (quoted or not)
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '\\' && i + 1 < line.length && (line[i + 1] === '"' || line[i + 1] === '\\')) {
        current += line[i + 1];
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
      inToken = true;
    } else if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
    } else {
      current += ch;
      inToken = true;
    }
  }
  if (inToken) tokens.push(current);
  return tokens;
}

/** Serialize one reply value as a single line. */
function encodeReply(value) {
  if (value instanceof Error) {
    return JSON.stringify({ error: value.message }) + '\n';
  }
  return JSON.stringify(value === undefined ? null : value) + '\n';
}

module.exports = { parseLine, encodeReply };
