'use strict';

/**
 * End-to-end test over real TCP: protocol, transactions, persistence
 * across a server restart, and pub/sub fan-out between two clients.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TinyRedisServer } = require('../src/server');

const servers = [];
const clients = [];

async function startServer(extra = {}) {
  const server = new TinyRedisServer({ port: 0, ...extra });
  await server.start();
  servers.push(server);
  return server;
}

function portOf(server) {
  return server.server.address().port;
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port }, () => {
      const client = { socket, pending: [], messages: [], buffer: '' };
      socket.on('data', (chunk) => {
        client.buffer += chunk.toString('utf8');
        let idx;
        while ((idx = client.buffer.indexOf('\n')) !== -1) {
          const line = client.buffer.slice(0, idx);
          client.buffer = client.buffer.slice(idx + 1);
          let value;
          try {
            value = JSON.parse(line);
          } catch {
            continue;
          }
          if (value && typeof value === 'object' && value.type === 'message') {
            client.messages.push(value);
          } else if (client.pending.length > 0) {
            client.pending.shift()(value);
          }
        }
      });
      clients.push(client);
      resolve(client);
    });
    socket.on('error', reject);
  });
}

function cmd(client, line) {
  return new Promise((resolve) => {
    client.pending.push(resolve);
    client.socket.write(line + '\n');
  });
}

after(async () => {
  for (const c of clients) c.socket.destroy();
  for (const s of servers) await s.stop();
});

test('SET/GET and friends over TCP', async () => {
  const server = await startServer();
  const c = await connect(portOf(server));
  assert.equal(await cmd(c, 'PING'), 'PONG');
  assert.equal(await cmd(c, 'SET greeting "hello tcp"'), 'OK');
  assert.equal(await cmd(c, 'GET greeting'), 'hello tcp');
  assert.equal(await cmd(c, 'INCR counter'), 1);
  assert.deepEqual(await cmd(c, 'MGET greeting counter missing'), ['hello tcp', '1', null]);
  assert.deepEqual(await cmd(c, 'GET nope'), null);
  const err = await cmd(c, 'BOGUS');
  assert.match(err.error, /unknown command/);
});

test('MULTI/EXEC over TCP runs as one atomic batch', async () => {
  const server = await startServer();
  const c = await connect(portOf(server));
  assert.equal(await cmd(c, 'MULTI'), 'OK');
  assert.equal(await cmd(c, 'SET a 10'), 'QUEUED');
  assert.equal(await cmd(c, 'INCRBY a 5'), 'QUEUED');
  assert.deepEqual(await cmd(c, 'EXEC'), ['OK', 15]);
  assert.equal(await cmd(c, 'GET a'), '15');
});

test('writes survive a server restart via the AOF log', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tinyredis-int-'));
  const aof = path.join(dir, 'data.aof');

  const s1 = await startServer({ aofPath: aof });
  const c1 = await connect(portOf(s1));
  assert.equal(await cmd(c1, 'SET persistent yes'), 'OK');
  assert.equal(await cmd(c1, 'HSET user name ada'), 1);
  assert.equal(await cmd(c1, 'MULTI'), 'OK');
  assert.equal(await cmd(c1, 'RPUSH q x'), 'QUEUED');
  assert.deepEqual(await cmd(c1, 'EXEC'), [1]);
  await s1.stop();
  servers.splice(servers.indexOf(s1), 1);

  const s2 = await startServer({ aofPath: aof });
  const c2 = await connect(portOf(s2));
  assert.equal(await cmd(c2, 'GET persistent'), 'yes');
  assert.equal(await cmd(c2, 'HGET user name'), 'ada');
  assert.deepEqual(await cmd(c2, 'LRANGE q 0 -1'), ['x']);

  const log = fs.readFileSync(aof, 'utf8').trim().split('\n');
  assert.ok(log.includes('SET persistent yes'));
  assert.ok(log.includes('RPUSH q x'));
  assert.ok(!log.some((l) => l.startsWith('MULTI') || l.startsWith('EXEC')));
});

test('pub/sub fans out to every subscriber', async () => {
  const server = await startServer();
  const sub1 = await connect(portOf(server));
  const sub2 = await connect(portOf(server));
  const pub = await connect(portOf(server));

  await cmd(sub1, 'SUBSCRIBE alerts');
  await cmd(sub2, 'SUBSCRIBE alerts');
  assert.equal(await cmd(pub, 'PUBLISH alerts "disk full"'), 2);

  await new Promise((r) => setTimeout(r, 100));
  for (const sub of [sub1, sub2]) {
    assert.equal(sub.messages.length, 1);
    assert.equal(sub.messages[0].channel, 'alerts');
    assert.equal(sub.messages[0].message, 'disk full');
  }

  // subscribed connections reject data commands, like real Redis
  const err = await cmd(sub1, 'SET a 1');
  assert.match(err.error, /subscribed mode/);
  await cmd(sub1, 'UNSUBSCRIBE');
  assert.equal(await cmd(sub1, 'SET a 1'), 'OK');
});

test('expiry is enforced for TCP clients', async () => {
  const server = await startServer();
  const c = await connect(portOf(server));
  assert.equal(await cmd(c, 'SET temp x PX 50'), 'OK');
  assert.equal(await cmd(c, 'GET temp'), 'x');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(await cmd(c, 'GET temp'), null);
});
