'use strict';

/**
 * Pub/sub hub. Channels map to a set of subscriber records; publishing
 * fans a message out to every subscriber's send() function.
 * Delivery is synchronous — fine on Node's single thread.
 */
class PubSub {
  constructor() {
    /** @type {Map<string, Set<{session: object, send: Function}>>} */
    this.channels = new Map();
  }

  subscribe(channel, session, send) {
    if (!this.channels.has(channel)) this.channels.set(channel, new Set());
    this.channels.get(channel).add({ session, send });
    session.subscriptions.add(channel);
    return session.subscriptions.size;
  }

  unsubscribe(channel, session) {
    const subs = this.channels.get(channel);
    if (subs) {
      for (const sub of subs) {
        if (sub.session === session) subs.delete(sub);
      }
      if (subs.size === 0) this.channels.delete(channel);
    }
    session.subscriptions.delete(channel);
    return session.subscriptions.size;
  }

  unsubscribeAll(session) {
    for (const channel of [...session.subscriptions]) {
      this.unsubscribe(channel, session);
    }
  }

  /** @returns {number} receivers the message was delivered to */
  publish(channel, message) {
    const subs = this.channels.get(channel);
    if (!subs || subs.size === 0) return 0;
    const frame = JSON.stringify({ type: 'message', channel, message }) + '\n';
    for (const sub of subs) {
      try {
        sub.send(frame);
      } catch {
        // A dead socket must not break delivery to the rest.
      }
    }
    return subs.size;
  }
}

module.exports = { PubSub };
