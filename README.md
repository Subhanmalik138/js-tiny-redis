# tiny-redis

A tiny Redis clone in Node.js — zero dependencies. A real TCP server with a
TTL key store (strings, lists, hashes), append-only persistence, pub/sub, and
MULTI/EXEC transactions, plus an interactive CLI client. Built to learn how
Redis actually works: the wire protocol, expiry, durability, and why a
single-threaded event loop makes transactions easy.

## Quick start

```bash
# start the server (default port 6379, no persistence)
node bin/tiny-redis-server

# with append-only persistence
node bin/tiny-redis-server --port 6379 --aof ./tinyredis.aof

# in another terminal, open the CLI
node bin/tiny-redis-cli
```

```
127.0.0.1:6379> SET greeting "hello world"
"OK"
127.0.0.1:6379> GET greeting
"hello world"
127.0.0.1:6379> HSET user name ada
(integer) 1
127.0.0.1:6379> SUBSCRIBE alerts
1) {"subscribed":"alerts","subscriptions":1}
```

## Design decisions

1. **Line protocol with JSON replies instead of RESP.** Requests are
   whitespace-separated tokens (`SET key "quoted value"`); every reply is one
   JSON value per line and errors are `{"error": "..."}`. It keeps the parser
   to ~40 lines while still teaching framing, quoting, and error encoding —
   the same problems RESP solves.
2. **Lazy expiry plus a periodic sweep.** Every read checks the key's
   deadline first (so expired keys vanish immediately), and the server sweeps
   once a second so dead keys don't pile up in memory. The clock is
   injectable (`store.now`), which makes TTL fully deterministic in tests.
3. **AOF logs the client's exact line.** Write commands are appended
   verbatim, so replay is just re-parsing — no separate serialization
   format to keep in sync. Queued transaction writes are logged once at
   `EXEC`, never at queue time; `PUBLISH` is never logged (pub/sub is
   ephemeral by design).
4. **Transactions ride the event loop.** Commands queued in `MULTI` run
   back-to-back inside `EXEC` with no `await` between them, so nothing can
   interleave — the same reason real Redis transactions are atomic.

## Commands

| Group | Commands |
|---|---|
| Connection | `PING`, `ECHO`, `QUIT` |
| Strings | `SET` (`EX`/`PX`/`NX`/`XX`), `GET`, `MSET`, `MGET`, `INCR`, `DECR`, `INCRBY`, `DECRBY`, `APPEND` |
| Keys | `DEL`, `EXISTS`, `EXPIRE`, `TTL`, `PERSIST`, `TYPE`, `RENAME`, `KEYS` (glob `*`/`?`), `DBSIZE`, `FLUSHDB` |
| Hashes | `HSET`, `HGET`, `HGETALL`, `HDEL` |
| Lists | `LPUSH`, `RPUSH`, `LPOP`, `RPOP`, `LLEN`, `LRANGE` (negative indexes) |
| Transactions | `MULTI`, `EXEC`, `DISCARD` |
| Pub/sub | `SUBSCRIBE`, `UNSUBSCRIBE`, `PUBLISH` |

Not implemented on purpose: `WATCH`, pattern subscriptions, RDB snapshots,
clustering — each would double the scope without teaching anything new about
the core ideas.

## How to run

```bash
node bin/tiny-redis-server [--port 6379] [--aof ./tinyredis.aof]
node bin/tiny-redis-cli [--host 127.0.0.1] [--port 6379]
node examples/demo.js   # in-process tour of the command layer, no network
```

## How to run tests

```bash
npm test   # node --test over test/*.test.js — 46 tests, no dependencies
```

The suite covers the store (expiry edge cases, wrong-type errors, glob
matching), the protocol parser, every command, AOF replay, transactions,
pub/sub, and end-to-end TCP tests including a server restart that proves
writes survive via the log.

## Project structure

```
src/
  store.js        # in-memory key store: strings/lists/hashes + TTL
  protocol.js     # line parser and JSON reply encoder
  commands.js     # command dispatcher (SET/GET/HSET/MULTI/...)
  persistence.js  # AOF append + replay
  pubsub.js       # channel fan-out hub
  server.js       # TCP server, sessions, expiry sweep
  index.js        # public API
bin/
  tiny-redis-server
  tiny-redis-cli  # interactive client with pub/sub message printing
test/             # unit + TCP integration tests
examples/demo.js
```

## Tech stack

Node.js 18+ (built-in `node:test`, no npm dependencies), plain CommonJS.
