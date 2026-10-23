'use strict';

/**
 * Quick in-process demo of the store + command layer (no network).
 * Run: node examples/demo.js
 */
const { Store, CommandHandler, parseLine } = require('../src');

const handler = new CommandHandler(new Store());
const script = [
  'SET user:1:name "Ada Lovelace"',
  'HSET user:1 role engineer',
  'RPUSH user:1:tags js redis',
  'SET session:abc token123 EX 3600',
  'MGET user:1:name user:1:role',
  'HGETALL user:1',
  'LRANGE user:1:tags 0 -1',
  'TTL session:abc',
];

for (const line of script) {
  const reply = handler.execute(parseLine(line));
  console.log(`> ${line}\n${JSON.stringify(reply)}`);
}
