'use strict';

/**
 * TCP server for the tiny-redis wire protocol.
 *
 * Each connection gets a session object that carries its CommandHandler
 * plus per-connection state (transactions, subscriptions — added later).
 * The store is shared across connections; Node's single thread makes each
 * command atomic, which is exactly how real Redis gets away with it.
 */
const net = require('net');
const { parseLine, encodeReply } = require('./protocol');
const { CommandHandler, ExecOutcome } = require('./commands');
const { replayLog, makeAppender } = require('./persistence');
const { PubSub } = require('./pubsub');
const { Store } = require('./store');

class TinyRedisServer {
  constructor(options = {}) {
    this.port = options.port || 6379;
    this.aofPath = options.aofPath || null;
    this.store = options.store || new Store();
    this.pubsub = options.pubsub || new PubSub();
    this.sweepIntervalMs = options.sweepIntervalMs || 1000;
    this.sessions = new Map();
    this.appender = this.aofPath ? makeAppender(this.aofPath) : null;
    this.server = net.createServer((socket) => this._onConnection(socket));
  }

  async start() {
    if (this.aofPath) {
      const replayed = replayLog(new CommandHandler(this.store), this.aofPath);
      if (replayed > 0) console.log(`[tiny-redis] replayed ${replayed} commands from ${this.aofPath}`);
    }
    this.sweepTimer = setInterval(() => this.store.sweep(), this.sweepIntervalMs);
    this.sweepTimer.unref();
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, resolve);
    });
    console.log(`[tiny-redis] listening on port ${this.port}`);
  }

  async stop() {
    clearInterval(this.sweepTimer);
    for (const socket of this.sessions.keys()) socket.destroy();
    await new Promise((resolve) => this.server.close(resolve));
    if (this.appender) await this.appender.close();
  }

  _onConnection(socket) {
    const handler = new CommandHandler(this.store, this.pubsub);
    const session = { handler, multi: null, subscriptions: new Set(), send: (line) => socket.write(line) };
    this.sessions.set(socket, session);
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) this._handleLine(socket, session, line);
      }
    });

    socket.on('close', () => {
      this.pubsub.unsubscribeAll(session);
      this.sessions.delete(socket);
    });
    socket.on('error', () => {});
  }

  _handleLine(socket, session, line) {
    let tokens;
    try {
      tokens = parseLine(line);
    } catch {
      socket.write(encodeReply(new Error('ERR protocol error')));
      return;
    }
    if (tokens.length === 0) return;

    const cmd = tokens[0].toUpperCase();
    if (cmd === 'QUIT' || cmd === 'EXIT') {
      socket.write(encodeReply('OK'));
      socket.end();
      return;
    }

    let reply;
    try {
      reply = session.handler.execute(tokens, session, line);
    } catch (err) {
      reply = err;
    }

    if (reply instanceof ExecOutcome) {
      if (this.appender) {
        for (const raw of reply.writeLines) this.appender.append(raw);
      }
      socket.write(encodeReply(reply.replies));
      return;
    }

    if (!(reply instanceof Error) && this.appender && !session.multi && CommandHandler.isWriteCommand(tokens)) {
      this.appender.append(line);
    }
    socket.write(encodeReply(reply));
  }
}

module.exports = { TinyRedisServer };
