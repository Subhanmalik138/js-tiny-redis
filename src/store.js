'use strict';

/**
 * In-memory key store with Redis-like semantics.
 *
 * Types: string, list, hash. Each key can carry an absolute expiry timestamp
 * (ms since epoch). Expiry is enforced lazily on every access plus an
 * explicit sweep() that the server calls on a timer, so memory does not
 * grow unbounded with dead keys.
 */
class Store {
  constructor() {
    /** @type {Map<string, {type: string, value: any, expiresAt: number|null}>} */
    this.entries = new Map();
    // Function source for the clock; injectable so tests can time-travel.
    this.now = () => Date.now();
  }

  /** Internal: fetch the entry, deleting it first if it has expired. */
  _get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  _assertType(key, want) {
    const entry = this._get(key);
    if (!entry) return undefined;
    if (entry.type !== want) {
      throw new Error(`WRONGTYPE Operation against a key holding the wrong kind of value`);
    }
    return entry;
  }

  // ---- strings -----------------------------------------------------------

  /**
   * @param {string} key
   * @param {string} value
   * @param {{ex?: number, px?: number, nx?: boolean, xx?: boolean}} [opts]
   * @returns {'OK'|null} null when NX/XX conditions are not met.
   */
  set(key, value, opts = {}) {
    const exists = this._get(key) !== undefined;
    if (opts.nx && exists) return null;
    if (opts.xx && !exists) return null;
    let expiresAt = null;
    if (opts.ex !== undefined) expiresAt = this.now() + opts.ex * 1000;
    if (opts.px !== undefined) expiresAt = this.now() + opts.px;
    this.entries.set(key, { type: 'string', value: String(value), expiresAt });
    return 'OK';
  }

  get(key) {
    const entry = this._assertType(key, 'string');
    return entry ? entry.value : null;
  }

  append(key, value) {
    const entry = this._get(key);
    if (!entry) {
      this.entries.set(key, { type: 'string', value: String(value), expiresAt: null });
      return String(value).length;
    }
    this._assertType(key, 'string');
    entry.value += String(value);
    return entry.value.length;
  }

  incrBy(key, delta) {
    let current = 0;
    const entry = this._get(key);
    if (entry) {
      this._assertType(key, 'string');
      if (!/^-?\d+$/.test(entry.value)) {
        throw new Error('ERR value is not an integer or out of range');
      }
      current = parseInt(entry.value, 10);
    }
    const next = current + delta;
    if (!Number.isSafeInteger(next)) {
      throw new Error('ERR increment or decrement would overflow');
    }
    this.entries.set(key, {
      type: 'string',
      value: String(next),
      expiresAt: entry ? entry.expiresAt : null,
    });
    return next;
  }

  // ---- generic key space -------------------------------------------------

  del(...keys) {
    let n = 0;
    for (const key of keys) {
      if (this._get(key) !== undefined) {
        this.entries.delete(key);
        n++;
      }
    }
    return n;
  }

  exists(...keys) {
    return keys.filter((k) => this._get(k) !== undefined).length;
  }

  expire(key, seconds) {
    const entry = this._get(key);
    if (!entry) return 0;
    entry.expiresAt = this.now() + seconds * 1000;
    return 1;
  }

  ttl(key) {
    const entry = this._get(key);
    if (!entry) return -2;
    if (entry.expiresAt === null) return -1;
    return Math.max(0, Math.ceil((entry.expiresAt - this.now()) / 1000));
  }

  persist(key) {
    const entry = this._get(key);
    if (!entry || entry.expiresAt === null) return 0;
    entry.expiresAt = null;
    return 1;
  }

  type(key) {
    const entry = this._get(key);
    return entry ? entry.type : 'none';
  }

  rename(key, newKey) {
    const entry = this._get(key);
    if (!entry) throw new Error('ERR no such key');
    this.entries.delete(key);
    this.entries.set(newKey, entry);
    return 'OK';
  }

  /** Glob match supporting '*' and '?' only — enough for KEYS. */
  static globMatch(pattern, str) {
    let px = 0, sx = 0, star = -1, mark = 0;
    while (sx < str.length) {
      if (px < pattern.length && (pattern[px] === '?' || pattern[px] === str[sx])) {
        px++; sx++;
      } else if (px < pattern.length && pattern[px] === '*') {
        star = px++; mark = sx;
      } else if (star !== -1) {
        px = star + 1; sx = ++mark;
      } else {
        return false;
      }
    }
    while (px < pattern.length && pattern[px] === '*') px++;
    return px === pattern.length;
  }

  keys(pattern = '*') {
    const out = [];
    for (const key of this.entries.keys()) {
      if (this._get(key) !== undefined && Store.globMatch(pattern, key)) out.push(key);
    }
    return out;
  }

  flushdb() {
    const n = this.entries.size;
    this.entries.clear();
    return n;
  }

  dbsize() {
    this.sweep();
    return this.entries.size;
  }

  /** Remove all expired keys; returns how many were dropped. */
  sweep() {
    let n = 0;
    for (const key of this.entries.keys()) {
      if (this._get(key) === undefined) n++;
    }
    return n;
  }

  // ---- hashes ------------------------------------------------------------

  _hash(key, create) {
    const entry = this._get(key);
    if (!entry) {
      if (!create) return undefined;
      const fresh = { type: 'hash', value: new Map(), expiresAt: null };
      this.entries.set(key, fresh);
      return fresh;
    }
    this._assertType(key, 'hash');
    return entry;
  }

  hset(key, ...fieldValues) {
    if (fieldValues.length % 2 !== 0) {
      throw new Error("ERR wrong number of arguments for 'hset' command");
    }
    const entry = this._hash(key, true);
    let added = 0;
    for (let i = 0; i < fieldValues.length; i += 2) {
      if (!entry.value.has(fieldValues[i])) added++;
      entry.value.set(fieldValues[i], fieldValues[i + 1]);
    }
    return added;
  }

  hget(key, field) {
    const entry = this._hash(key, false);
    return entry && entry.value.has(field) ? entry.value.get(field) : null;
  }

  hgetall(key) {
    const entry = this._hash(key, false);
    if (!entry) return [];
    const out = [];
    for (const [f, v] of entry.value) out.push(f, v);
    return out;
  }

  hdel(key, ...fields) {
    const entry = this._hash(key, false);
    if (!entry) return 0;
    let n = 0;
    for (const f of fields) {
      if (entry.value.delete(f)) n++;
    }
    if (entry.value.size === 0) this.entries.delete(key);
    return n;
  }

  // ---- lists -------------------------------------------------------------

  _list(key, create) {
    const entry = this._get(key);
    if (!entry) {
      if (!create) return undefined;
      const fresh = { type: 'list', value: [], expiresAt: null };
      this.entries.set(key, fresh);
      return fresh;
    }
    this._assertType(key, 'list');
    return entry;
  }

  lpush(key, ...values) {
    const entry = this._list(key, true);
    for (const v of values) entry.value.unshift(v);
    return entry.value.length;
  }

  rpush(key, ...values) {
    const entry = this._list(key, true);
    entry.value.push(...values);
    return entry.value.length;
  }

  lpop(key) {
    const entry = this._list(key, false);
    if (!entry || entry.value.length === 0) return null;
    const v = entry.value.shift();
    if (entry.value.length === 0) this.entries.delete(key);
    return v;
  }

  rpop(key) {
    const entry = this._list(key, false);
    if (!entry || entry.value.length === 0) return null;
    const v = entry.value.pop();
    if (entry.value.length === 0) this.entries.delete(key);
    return v;
  }

  llen(key) {
    const entry = this._list(key, false);
    return entry ? entry.value.length : 0;
  }

  lrange(key, start, stop) {
    const entry = this._list(key, false);
    if (!entry) return [];
    const len = entry.value.length;
    const norm = (i) => (i < 0 ? Math.max(len + i, 0) : Math.min(i, len));
    const s = norm(start), e = norm(stop);
    return s > e ? [] : entry.value.slice(s, e + 1);
  }
}

module.exports = { Store };
