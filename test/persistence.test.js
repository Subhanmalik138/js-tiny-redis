'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');
const { CommandHandler } = require('../src/commands');
const { replayLog, makeAppender } = require('../src/persistence');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tinyredis-')), 'test.aof');
}

test('replay restores writes in order', () => {
  const file = tmpFile();
  fs.writeFileSync(file, 'SET a 1\nINCRBY a 4\nHSET u name ada\nDEL missing\n');
  const handler = new CommandHandler(new Store());
  assert.equal(replayLog(handler, file), 4);
  assert.equal(handler.execute(['GET', 'a']), '5');
  assert.equal(handler.execute(['HGET', 'u', 'name']), 'ada');
});

test('replay skips corrupt and non-write lines', () => {
  const file = tmpFile();
  fs.writeFileSync(file, 'SET a 1\nGET a\nBOGUS !!\nSET b 2\n');
  const handler = new CommandHandler(new Store());
  assert.equal(replayLog(handler, file), 2);
  assert.equal(handler.execute(['MGET', 'a', 'b']).join(','), '1,2');
});

test('replay on missing file returns 0', () => {
  const handler = new CommandHandler(new Store());
  assert.equal(replayLog(handler, path.join(os.tmpdir(), 'definitely-not-here.aof')), 0);
});

test('appender writes lines the replay can read', async () => {
  const file = tmpFile();
  const appender = makeAppender(file);
  appender.append('SET k v');
  appender.append('LPUSH l a');
  await appender.close();
  const handler = new CommandHandler(new Store());
  assert.equal(replayLog(handler, file), 2);
  assert.equal(handler.execute(['GET', 'k']), 'v');
});
