'use strict';

/**
 * Maps parsed tokens to Store operations.
 *
 * execute(tokens) returns the reply value, or throws an Error whose message
 * becomes the {"error": ...} reply. Commands are case-insensitive.
 *
 * WRITE_COMMANDS lists the commands the server must append to the AOF log.
 */
const { Store } = require('./store');

const WRITE_COMMANDS = new Set([
  'SET', 'MSET', 'DEL', 'EXPIRE', 'PERSIST', 'RENAME',
  'INCR', 'DECR', 'INCRBY', 'DECRBY', 'APPEND',
  'HSET', 'HDEL', 'LPUSH', 'RPUSH', 'LPOP', 'RPOP', 'FLUSHDB',
]);

function wrongArgs(cmd) {
  return new Error(`ERR wrong number of arguments for '${cmd}' command`);
}

function toInt(value, cmd) {
  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw new Error(`ERR value is not an integer or out of range`);
  }
  return n;
}

class CommandHandler {
  constructor(store = new Store()) {
    this.store = store;
  }

  execute(tokens) {
    if (tokens.length === 0) throw new Error('ERR empty command');
    const cmd = tokens[0].toUpperCase();
    const args = tokens.slice(1);
    const fn = this['cmd_' + cmd];
    if (!fn) throw new Error(`ERR unknown command '${tokens[0]}'`);
    return fn.call(this, args, cmd);
  }

  static isWriteCommand(tokens) {
    return tokens.length > 0 && WRITE_COMMANDS.has(tokens[0].toUpperCase());
  }

  // ---- connection -------------------------------------------------------
  cmd_PING(args) {
    if (args.length > 1) throw wrongArgs('ping');
    return args.length === 1 ? args[0] : 'PONG';
  }

  cmd_ECHO(args) {
    if (args.length !== 1) throw wrongArgs('echo');
    return args[0];
  }

  // ---- strings -----------------------------------------------------------
  cmd_SET(args) {
    if (args.length < 2) throw wrongArgs('set');
    const [key, value, ...opts] = args;
    const options = {};
    for (let i = 0; i < opts.length; i++) {
      const opt = opts[i].toUpperCase();
      if (opt === 'EX') {
        if (++i >= opts.length) throw new Error('ERR syntax error');
        options.ex = toInt(opts[i], 'set');
      } else if (opt === 'PX') {
        if (++i >= opts.length) throw new Error('ERR syntax error');
        options.px = toInt(opts[i], 'set');
      } else if (opt === 'NX') {
        options.nx = true;
      } else if (opt === 'XX') {
        options.xx = true;
      } else {
        throw new Error('ERR syntax error');
      }
    }
    return this.store.set(key, value, options);
  }

  cmd_GET(args) {
    if (args.length !== 1) throw wrongArgs('get');
    return this.store.get(args[0]);
  }

  cmd_MSET(args) {
    if (args.length === 0 || args.length % 2 !== 0) throw wrongArgs('mset');
    for (let i = 0; i < args.length; i += 2) {
      this.store.set(args[i], args[i + 1]);
    }
    return 'OK';
  }

  cmd_MGET(args) {
    if (args.length === 0) throw wrongArgs('mget');
    return args.map((k) => this.store.get(k));
  }

  cmd_INCR(args) {
    if (args.length !== 1) throw wrongArgs('incr');
    return this.store.incrBy(args[0], 1);
  }

  cmd_DECR(args) {
    if (args.length !== 1) throw wrongArgs('decr');
    return this.store.incrBy(args[0], -1);
  }

  cmd_INCRBY(args) {
    if (args.length !== 2) throw wrongArgs('incrby');
    return this.store.incrBy(args[0], toInt(args[1], 'incrby'));
  }

  cmd_DECRBY(args) {
    if (args.length !== 2) throw wrongArgs('decrby');
    return this.store.incrBy(args[0], -toInt(args[1], 'decrby'));
  }

  cmd_APPEND(args) {
    if (args.length !== 2) throw wrongArgs('append');
    return this.store.append(args[0], args[1]);
  }

  // ---- generic ------------------------------------------------------------
  cmd_DEL(args) {
    if (args.length === 0) throw wrongArgs('del');
    return this.store.del(...args);
  }

  cmd_EXISTS(args) {
    if (args.length === 0) throw wrongArgs('exists');
    return this.store.exists(...args);
  }

  cmd_EXPIRE(args) {
    if (args.length !== 2) throw wrongArgs('expire');
    return this.store.expire(args[0], toInt(args[1], 'expire'));
  }

  cmd_TTL(args) {
    if (args.length !== 1) throw wrongArgs('ttl');
    return this.store.ttl(args[0]);
  }

  cmd_PERSIST(args) {
    if (args.length !== 1) throw wrongArgs('persist');
    return this.store.persist(args[0]);
  }

  cmd_TYPE(args) {
    if (args.length !== 1) throw wrongArgs('type');
    return this.store.type(args[0]);
  }

  cmd_RENAME(args) {
    if (args.length !== 2) throw wrongArgs('rename');
    return this.store.rename(args[0], args[1]);
  }

  cmd_KEYS(args) {
    if (args.length > 1) throw wrongArgs('keys');
    return this.store.keys(args[0] || '*');
  }

  cmd_DBSIZE(args) {
    if (args.length !== 0) throw wrongArgs('dbsize');
    return this.store.dbsize();
  }

  cmd_FLUSHDB(args) {
    if (args.length !== 0) throw wrongArgs('flushdb');
    this.store.flushdb();
    return 'OK';
  }

  // ---- hashes --------------------------------------------------------------
  cmd_HSET(args) {
    if (args.length < 3 || args.length % 2 !== 1) throw wrongArgs('hset');
    return this.store.hset(args[0], ...args.slice(1));
  }

  cmd_HGET(args) {
    if (args.length !== 2) throw wrongArgs('hget');
    return this.store.hget(args[0], args[1]);
  }

  cmd_HGETALL(args) {
    if (args.length !== 1) throw wrongArgs('hgetall');
    return this.store.hgetall(args[0]);
  }

  cmd_HDEL(args) {
    if (args.length < 2) throw wrongArgs('hdel');
    return this.store.hdel(args[0], ...args.slice(1));
  }

  // ---- lists ----------------------------------------------------------------
  cmd_LPUSH(args) {
    if (args.length < 2) throw wrongArgs('lpush');
    return this.store.lpush(args[0], ...args.slice(1));
  }

  cmd_RPUSH(args) {
    if (args.length < 2) throw wrongArgs('rpush');
    return this.store.rpush(args[0], ...args.slice(1));
  }

  cmd_LPOP(args) {
    if (args.length !== 1) throw wrongArgs('lpop');
    return this.store.lpop(args[0]);
  }

  cmd_RPOP(args) {
    if (args.length !== 1) throw wrongArgs('rpop');
    return this.store.rpop(args[0]);
  }

  cmd_LLEN(args) {
    if (args.length !== 1) throw wrongArgs('llen');
    return this.store.llen(args[0]);
  }

  cmd_LRANGE(args) {
    if (args.length !== 3) throw wrongArgs('lrange');
    return this.store.lrange(args[0], toInt(args[1], 'lrange'), toInt(args[2], 'lrange'));
  }
}

module.exports = { CommandHandler, WRITE_COMMANDS };
