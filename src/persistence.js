'use strict';

/**
 * Append-only file (AOF) persistence.
 *
 * Every write command is appended to the log as the exact line the client
 * sent, so replay is just re-parsing and re-executing. On boot the log is
 * replayed top to bottom; corrupt lines are skipped with a warning rather
 * than killing the server.
 */
const fs = require('fs');
const { parseLine } = require('./protocol');
const { CommandHandler } = require('./commands');

/** Replay an AOF log into the handler's store. Returns lines replayed. */
function replayLog(handler, path) {
  let count = 0;
  if (!fs.existsSync(path)) return count;
  const data = fs.readFileSync(path, 'utf8');
  for (const rawLine of data.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const tokens = parseLine(line);
      if (CommandHandler.isWriteCommand(tokens)) {
        handler.execute(tokens);
        count++;
      }
    } catch (err) {
      console.warn(`[aof] skipping corrupt line: ${line}`);
    }
  }
  return count;
}

/** Returns an append function; the stream is opened lazily on first write. */
function makeAppender(path) {
  let stream = null;
  return {
    append(line) {
      if (!stream) stream = fs.createWriteStream(path, { flags: 'a' });
      stream.write(line + '\n');
    },
    close() {
      return new Promise((resolve) => {
        if (!stream) return resolve();
        stream.end(resolve);
      });
    },
  };
}

module.exports = { replayLog, makeAppender };
