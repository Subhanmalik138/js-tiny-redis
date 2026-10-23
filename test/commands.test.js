'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseLine, encodeReply } = require('../src/protocol');
const { CommandHandler } = require('../src/commands');

function run(...lines) {
  const h = new CommandHandler();
  return lines.map((l) => h.execute(parseLine(l)));
}

test('protocol: quoting and escapes', () => {
  assert.deepEqual(parseLine('SET key "hello world"'), ['SET', 'key', 'hello world']);
  assert.deepEqual(parseLine('SET k "a \\"b\\" c"'), ['SET', 'k', 'a "b" c']);
  assert.deepEqual(parseLine('SET k ""'), ['SET', 'k', '']);
  assert.deepEqual(parseLine('  GET   spaced  '), ['GET', 'spaced']);
  assert.deepEqual(parseLine(''), []);
});

test('protocol: replies are single-line JSON', () => {
  assert.equal(encodeReply('OK'), '"OK"\n');
  assert.equal(encodeReply(null), 'null\n');
  assert.equal(encodeReply(['a', 1]), '["a",1]\n');
  assert.equal(encodeReply(new Error('ERR nope')), '{"error":"ERR nope"}\n');
});

test('PING/ECHO are case-insensitive', () => {
  assert.deepEqual(run('ping', 'Ping hi', 'ECHO yo'), ['PONG', 'hi', 'yo']);
});

test('unknown command and arg counts raise', () => {
  const h = new CommandHandler();
  assert.throws(() => h.execute(['FROBNICATE']), /unknown command/);
  assert.throws(() => h.execute(['GET']), /wrong number of arguments/);
  assert.throws(() => h.execute(['SET', 'a']), /wrong number of arguments/);
  assert.throws(() => h.execute([]), /empty command/);
});

test('SET with EX/PX/NX/XX options', () => {
  const h = new CommandHandler();
  h.store.now = () => 0;
  assert.equal(h.execute(['SET', 'a', '1', 'PX', '100']), 'OK');
  assert.equal(h.execute(['GET', 'a']), '1');
  h.store.now = () => 200;
  assert.equal(h.execute(['GET', 'a']), null);
  assert.throws(() => h.execute(['SET', 'b', '1', 'BOGUS']), /syntax error/);
  assert.throws(() => h.execute(['SET', 'b', '1', 'EX']), /syntax error/);
});

test('strings: MSET/MGET/INCR/DECR/APPEND', () => {
  assert.deepEqual(run('MSET a 1 b 2', 'MGET a b missing'), ['OK', ['1', '2', null]]);
  const h = new CommandHandler();
  assert.equal(h.execute(['INCR', 'n']), 1);
  assert.equal(h.execute(['INCRBY', 'n', '9']), 10);
  assert.equal(h.execute(['DECRBY', 'n', '3']), 7);
  assert.equal(h.execute(['DECR', 'n']), 6);
  assert.equal(h.execute(['APPEND', 's', 'ab']), 2);
  assert.throws(() => h.execute(['INCRBY', 'n', 'x']), /not an integer/);
  assert.throws(() => h.execute(['MSET', 'a']), /wrong number of arguments/);
});

test('generic: DEL EXISTS EXPIRE TTL PERSIST TYPE RENAME KEYS DBSIZE FLUSHDB', () => {
  const h = new CommandHandler();
  h.store.now = () => 0;
  h.execute(['SET', 'a', '1']);
  h.execute(['SET', 'b', '2']);
  assert.equal(h.execute(['TYPE', 'a']), 'string');
  assert.equal(h.execute(['TYPE', 'nope']), 'none');
  assert.equal(h.execute(['EXISTS', 'a', 'b', 'nope']), 2);
  assert.equal(h.execute(['EXPIRE', 'a', '100']), 1);
  assert.equal(h.execute(['TTL', 'a']), 100);
  assert.equal(h.execute(['PERSIST', 'a']), 1);
  assert.equal(h.execute(['TTL', 'a']), -1);
  assert.equal(h.execute(['RENAME', 'a', 'c']), 'OK');
  assert.equal(h.execute(['GET', 'c']), '1');
  assert.deepEqual(h.execute(['KEYS', '*']).sort(), ['b', 'c']);
  assert.equal(h.execute(['DBSIZE']), 2);
  assert.equal(h.execute(['DEL', 'b', 'c', 'nope']), 2);
  assert.equal(h.execute(['FLUSHDB']), 'OK');
  assert.equal(h.execute(['DBSIZE']), 0);
});

test('hashes over the dispatcher', () => {
  const h = new CommandHandler();
  assert.equal(h.execute(['HSET', 'u', 'name', 'ada', 'age', '36']), 2);
  assert.equal(h.execute(['HGET', 'u', 'name']), 'ada');
  assert.deepEqual(h.execute(['HGETALL', 'u']), ['name', 'ada', 'age', '36']);
  assert.equal(h.execute(['HDEL', 'u', 'age']), 1);
  assert.equal(h.execute(['TYPE', 'u']), 'hash');
});

test('lists over the dispatcher', () => {
  const h = new CommandHandler();
  assert.equal(h.execute(['RPUSH', 'q', 'a', 'b']), 2);
  assert.equal(h.execute(['LPUSH', 'q', 'z']), 3);
  assert.equal(h.execute(['LLEN', 'q']), 3);
  assert.deepEqual(h.execute(['LRANGE', 'q', '0', '-1']), ['z', 'a', 'b']);
  assert.equal(h.execute(['LPOP', 'q']), 'z');
  assert.equal(h.execute(['RPOP', 'q']), 'b');
});

test('WRONGTYPE surfaces through the dispatcher', () => {
  const h = new CommandHandler();
  h.execute(['SET', 's', 'x']);
  assert.throws(() => h.execute(['LPOP', 's']), /WRONGTYPE/);
});

test('isWriteCommand classification', () => {
  assert.ok(CommandHandler.isWriteCommand(['SET', 'a', 'b']));
  assert.ok(CommandHandler.isWriteCommand(['del', 'a']));
  assert.ok(!CommandHandler.isWriteCommand(['GET', 'a']));
  assert.ok(!CommandHandler.isWriteCommand(['PING']));
  assert.ok(!CommandHandler.isWriteCommand([]));
});
