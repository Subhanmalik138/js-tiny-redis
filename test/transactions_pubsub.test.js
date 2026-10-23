'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store');
const { PubSub } = require('../src/pubsub');
const { CommandHandler, ExecOutcome } = require('../src/commands');

function session() {
  const sent = [];
  return {
    multi: null,
    subscriptions: new Set(),
    send: (line) => sent.push(line),
    sent,
  };
}

function run(handler, sess, ...lines) {
  const { parseLine } = require('../src/protocol');
  return lines.map((l) => handler.execute(parseLine(l), sess, l));
}

// ---- transactions ---------------------------------------------------------

test('MULTI queues and EXEC runs atomically', () => {
  const h = new CommandHandler(new Store());
  const s = session();
  assert.equal(run(h, s, 'MULTI')[0], 'OK');
  assert.deepEqual(run(h, s, 'SET a 1', 'INCR a', 'GET a'), ['QUEUED', 'QUEUED', 'QUEUED']);
  const outcome = h.execute(['EXEC'], s);
  assert.ok(outcome instanceof ExecOutcome);
  assert.deepEqual(outcome.replies, ['OK', 2, '2']);
  assert.deepEqual(outcome.writeLines, ['SET a 1', 'INCR a']);
  assert.equal(h.execute(['GET', 'a'], s), '2');
});

test('quoted args keep their quoting in the AOF write lines', () => {
  const h = new CommandHandler(new Store());
  const s = session();
  run(h, s, 'MULTI', 'SET greeting "hello world"');
  const outcome = h.execute(['EXEC'], s, 'EXEC');
  assert.deepEqual(outcome.writeLines, ['SET greeting "hello world"']);
});

test('EXEC collects per-command errors without aborting', () => {
  const h = new CommandHandler(new Store());
  const s = session();
  run(h, s, 'MULTI', 'SET s str', 'LPOP s', 'SET ok 1');
  const outcome = h.execute(['EXEC'], s);
  assert.equal(outcome.replies[0], 'OK');
  assert.match(outcome.replies[1].error, /WRONGTYPE/);
  assert.equal(outcome.replies[2], 'OK');
});

test('DISCARD drops the queue; nesting is rejected', () => {
  const h = new CommandHandler(new Store());
  const s = session();
  run(h, s, 'MULTI', 'SET a 1');
  assert.equal(run(h, s, 'DISCARD')[0], 'OK');
  assert.throws(() => h.execute(['EXEC'], s), /EXEC without MULTI/);
  assert.equal(h.execute(['GET', 'a'], s), null);
  run(h, s, 'MULTI');
  assert.throws(() => h.execute(['MULTI'], s), /can not be nested/);
  run(h, s, 'DISCARD');
});

test('EXEC without MULTI and MULTI without a session raise', () => {
  const h = new CommandHandler(new Store());
  assert.throws(() => h.execute(['EXEC'], session()), /EXEC without MULTI/);
  assert.throws(() => h.execute(['DISCARD'], session()), /DISCARD without MULTI/);
  assert.throws(() => h.execute(['MULTI']), /requires a connection/);
});

test('empty transaction EXEC returns []', () => {
  const h = new CommandHandler(new Store());
  const s = session();
  run(h, s, 'MULTI');
  const outcome = h.execute(['EXEC'], s);
  assert.deepEqual(outcome.replies, []);
});

// ---- pub/sub ---------------------------------------------------------------

test('PUBLISH fans out to subscribers only', () => {
  const h = new CommandHandler(new Store());
  const a = session(), b = session(), c = session();
  h.execute(['SUBSCRIBE', 'news'], a);
  h.execute(['SUBSCRIBE', 'news'], b);
  assert.equal(h.execute(['PUBLISH', 'news', 'hi'], c), 2);
  assert.equal(h.execute(['PUBLISH', 'empty', 'x'], c), 0);
  for (const s of [a, b]) {
    assert.equal(s.sent.length, 1);
    const frame = JSON.parse(s.sent[0]);
    assert.equal(frame.type, 'message');
    assert.equal(frame.channel, 'news');
    assert.equal(frame.message, 'hi');
  }
  assert.equal(c.sent.length, 0);
});

test('SUBSCRIBE ack and UNSUBSCRIBE', () => {
  const h = new CommandHandler(new Store());
  const s = session();
  const acks = h.execute(['SUBSCRIBE', 'a', 'b'], s);
  assert.deepEqual(acks, [
    { subscribed: 'a', subscriptions: 1 },
    { subscribed: 'b', subscriptions: 2 },
  ]);
  const unacks = h.execute(['UNSUBSCRIBE', 'a'], s);
  assert.deepEqual(unacks, [{ unsubscribed: 'a', subscriptions: 1 }]);
  assert.equal(h.execute(['PUBLISH', 'a', 'x'], session()), 0);
  assert.equal(h.execute(['PUBLISH', 'b', 'x'], session()), 1);
});

test('UNSUBSCRIBE with no args clears all', () => {
  const h = new CommandHandler(new Store());
  const s = session();
  h.execute(['SUBSCRIBE', 'a', 'b'], s);
  h.execute(['UNSUBSCRIBE'], s);
  assert.equal(s.subscriptions.size, 0);
});

test('non-pubsub commands are rejected in subscribed mode', () => {
  const h = new CommandHandler(new Store());
  const s = session();
  h.execute(['SUBSCRIBE', 'news'], s);
  assert.throws(() => h.execute(['SET', 'a', '1'], s), /subscribed mode/);
  assert.throws(() => h.execute(['MULTI'], s), /subscribed mode/);
  assert.equal(h.execute(['PING'], s), 'PONG'); // allowed
  h.execute(['UNSUBSCRIBE'], s);
  assert.equal(h.execute(['SET', 'a', '1'], s), 'OK'); // allowed again
});

test('PUBLISH is ephemeral: not a write command for AOF', () => {
  assert.ok(!CommandHandler.isWriteCommand(['PUBLISH', 'c', 'm']));
});

test('PubSub.unsubscribeAll removes every registration', () => {
  const pubsub = new PubSub();
  const s = session();
  pubsub.subscribe('a', s, s.send);
  pubsub.subscribe('b', s, s.send);
  pubsub.unsubscribeAll(s);
  assert.equal(pubsub.publish('a', 'x'), 0);
  assert.equal(s.subscriptions.size, 0);
});
