'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store');

function storeAt(t) {
  const s = new Store();
  s.now = () => t;
  return s;
}

test('set/get round trip', () => {
  const s = new Store();
  assert.equal(s.set('a', '1'), 'OK');
  assert.equal(s.get('a'), '1');
  assert.equal(s.get('missing'), null);
});

test('SET NX only sets when absent', () => {
  const s = new Store();
  assert.equal(s.set('a', '1', { nx: true }), 'OK');
  assert.equal(s.set('a', '2', { nx: true }), null);
  assert.equal(s.get('a'), '1');
});

test('SET XX only sets when present', () => {
  const s = new Store();
  assert.equal(s.set('a', '1', { xx: true }), null);
  s.set('a', '1');
  assert.equal(s.set('a', '2', { xx: true }), 'OK');
  assert.equal(s.get('a'), '2');
});

test('expiry: lazy delete on access', () => {
  const s = storeAt(1000);
  s.set('a', '1', { px: 500 });
  s.now = () => 1400;
  assert.equal(s.get('a'), '1');
  assert.equal(s.ttl('a'), 1); // ceil(100/1000)
  s.now = () => 1600;
  assert.equal(s.get('a'), null);
  assert.equal(s.ttl('a'), -2);
});

test('EXPIRE/PERSIST/TTL round trip', () => {
  const s = storeAt(0);
  s.set('a', '1');
  assert.equal(s.expire('a', 60), 1);
  assert.equal(s.ttl('a'), 60);
  assert.equal(s.persist('a'), 1);
  assert.equal(s.ttl('a'), -1);
  assert.equal(s.expire('missing', 60), 0);
});

test('DEL/EXISTS/DBSIZE', () => {
  const s = new Store();
  s.set('a', '1'); s.set('b', '2');
  assert.equal(s.exists('a', 'b', 'nope'), 2);
  assert.equal(s.del('a', 'nope'), 1);
  assert.equal(s.dbsize(), 1);
  assert.equal(s.flushdb(), 1);
  assert.equal(s.dbsize(), 0);
});

test('sweep removes expired keys without access', () => {
  const s = storeAt(0);
  s.set('a', '1', { px: 10 });
  s.set('b', '2');
  s.now = () => 100;
  assert.equal(s.sweep(), 1);
  assert.deepEqual(s.keys(), ['b']);
});

test('KEYS glob matching', () => {
  const s = new Store();
  s.set('user:1', 'a'); s.set('user:2', 'b'); s.set('order:1', 'c');
  assert.deepEqual(s.keys('user:*').sort(), ['user:1', 'user:2']);
  assert.deepEqual(s.keys('*:1').sort(), ['order:1', 'user:1']);
  assert.deepEqual(s.keys('?????:1'), ['order:1']);
});

test('INCRBY rejects non-integers and overflow', () => {
  const s = new Store();
  s.set('n', '10');
  assert.equal(s.incrBy('n', 5), 15);
  assert.equal(s.incrBy('n', -20), -5);
  s.set('s', 'abc');
  assert.throws(() => s.incrBy('s', 1), /not an integer/);
  s.set('big', String(Number.MAX_SAFE_INTEGER));
  assert.throws(() => s.incrBy('big', 1), /overflow/);
});

test('APPEND concatenates', () => {
  const s = new Store();
  assert.equal(s.append('k', 'hello'), 5);
  assert.equal(s.append('k', ' world'), 11);
  assert.equal(s.get('k'), 'hello world');
});

test('hashes: HSET/HGET/HGETALL/HDEL', () => {
  const s = new Store();
  assert.equal(s.hset('h', 'f1', 'v1', 'f2', 'v2'), 2);
  assert.equal(s.hset('h', 'f1', 'v1b'), 0);
  assert.equal(s.hget('h', 'f1'), 'v1b');
  assert.equal(s.hget('h', 'nope'), null);
  assert.deepEqual(s.hgetall('h'), ['f1', 'v1b', 'f2', 'v2']);
  assert.equal(s.hdel('h', 'f1', 'nope'), 1);
  assert.equal(s.type('h'), 'hash');
  assert.throws(() => s.hset('h', 'odd'), /wrong number of arguments/);
});

test('lists: push/pop/range with negative indexes', () => {
  const s = new Store();
  assert.equal(s.rpush('l', 'a', 'b', 'c'), 3);
  assert.equal(s.lpush('l', 'z'), 4);
  assert.equal(s.lpop('l'), 'z');
  assert.equal(s.rpop('l'), 'c');
  assert.deepEqual(s.lrange('l', 0, -1), ['a', 'b']);
  assert.deepEqual(s.lrange('l', -1, -1), ['b']);
  assert.deepEqual(s.lrange('l', 5, 10), []);
  assert.equal(s.llen('l'), 2);
  assert.equal(s.llen('missing'), 0);
  assert.equal(s.lpop('missing'), null);
});

test('RENAME moves entry with its TTL', () => {
  const s = storeAt(0);
  s.set('a', '1', { ex: 60 });
  assert.equal(s.rename('a', 'b'), 'OK');
  assert.equal(s.get('a'), null);
  assert.equal(s.ttl('b'), 60);
  assert.throws(() => s.rename('nope', 'x'), /no such key/);
});

test('wrong-type operations raise', () => {
  const s = new Store();
  s.set('str', 'x');
  s.rpush('lst', 'y');
  assert.throws(() => s.get('lst'), /WRONGTYPE/);
  assert.throws(() => s.lpop('str'), /WRONGTYPE/);
  assert.throws(() => s.hget('str', 'f'), /WRONGTYPE/);
});
