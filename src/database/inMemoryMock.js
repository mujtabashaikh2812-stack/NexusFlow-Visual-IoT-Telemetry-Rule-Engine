'use strict';

/**
 * Dependency-free in-memory store that answers the same calls as the MongoDB
 * driver's Collection, so every module (and every CI run) works with no
 * database installed.
 *
 * Deliberately small and predictable:
 *  - filters: equality on dotted paths, $gt $gte $lt $lte $in $ne $exists,
 *    plus top-level $and / $or
 *  - updates: $set (dotted paths) and upsert
 *  - index metadata is recorded and returned by indexes(); uniqueness is NOT
 *    enforced (only the implicit _id uniqueness is)
 *  - every document handed out is a deep copy
 *
 * Data lives in process memory only and is lost on exit.
 */

// ---------------------------------------------------------------- helpers

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
}

function deepClone(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(deepClone);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) out[key] = deepClone(value[key]);
    return out;
  }
  return value;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function getPath(doc, path) {
  let cur = doc;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function setPath(doc, path, value) {
  const parts = path.split('.');
  let cur = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isPlainObject(cur[parts[i]])) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = deepClone(value);
}

/** Order two values; returns null when they are not comparable. */
function compareValues(a, b) {
  const x = a instanceof Date ? a.getTime() : a;
  const y = b instanceof Date ? b.getTime() : b;
  if (typeof x !== typeof y) return null;
  if (typeof x === 'number' || typeof x === 'string' || typeof x === 'boolean') {
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return null;
}

function isOperatorObject(cond) {
  if (!isPlainObject(cond)) return false;
  const keys = Object.keys(cond);
  return keys.length > 0 && keys.every((k) => k.startsWith('$'));
}

/** Equality that also lets a scalar match inside an array field, as MongoDB does. */
function equalsLoose(actual, expected) {
  if (deepEqual(actual, expected)) return true;
  return Array.isArray(actual) && !Array.isArray(expected) && actual.some((v) => deepEqual(v, expected));
}

function matchOperators(actual, ops) {
  for (const op of Object.keys(ops)) {
    const arg = ops[op];
    let ok;
    switch (op) {
      case '$gt': { const c = compareValues(actual, arg); ok = c !== null && c > 0; break; }
      case '$gte': { const c = compareValues(actual, arg); ok = c !== null && c >= 0; break; }
      case '$lt': { const c = compareValues(actual, arg); ok = c !== null && c < 0; break; }
      case '$lte': { const c = compareValues(actual, arg); ok = c !== null && c <= 0; break; }
      case '$in':
        if (!Array.isArray(arg)) throw new TypeError('$in needs an array');
        ok = arg.some((v) => equalsLoose(actual, v));
        break;
      case '$ne': ok = !equalsLoose(actual, arg); break;
      case '$exists': ok = (actual !== undefined) === Boolean(arg); break;
      default:
        throw new Error(`InMemoryStore: unsupported operator ${op}`);
    }
    if (!ok) return false;
  }
  return true;
}

function matches(doc, filter) {
  if (!filter) return true;
  for (const key of Object.keys(filter)) {
    const cond = filter[key];
    if (key === '$and') {
      if (!Array.isArray(cond) || !cond.every((f) => matches(doc, f))) return false;
    } else if (key === '$or') {
      if (!Array.isArray(cond) || !cond.some((f) => matches(doc, f))) return false;
    } else if (key.startsWith('$')) {
      throw new Error(`InMemoryStore: unsupported operator ${key}`);
    } else {
      const actual = getPath(doc, key);
      if (isOperatorObject(cond)) {
        if (!matchOperators(actual, cond)) return false;
      } else if (!equalsLoose(actual, cond)) {
        return false;
      }
    }
  }
  return true;
}

function duplicateKeyError(id) {
  const err = new Error(`E11000 duplicate key error: _id ${JSON.stringify(id)}`);
  err.name = 'MongoServerError';
  err.code = 11000;
  return err;
}

function indexName(key) {
  return Object.keys(key).map((k) => `${k}_${key[k]}`).join('_');
}

// ------------------------------------------------------------- collection

class InMemoryCursor {
  constructor(collection, filter) {
    this._collection = collection;
    this._filter = filter || {};
    this._sort = null;
    this._skip = 0;
    this._limit = 0;
  }

  sort(spec) {
    this._sort = spec;
    return this;
  }

  skip(n) {
    this._skip = Math.max(0, Number(n) || 0);
    return this;
  }

  limit(n) {
    this._limit = Math.max(0, Number(n) || 0);
    return this;
  }

  async toArray() {
    let entries = this._collection._entries.filter((e) => matches(e.doc, this._filter));
    if (this._sort) {
      const fields = Object.keys(this._sort);
      entries = entries.slice().sort((a, b) => {
        for (const f of fields) {
          const dir = this._sort[f] < 0 ? -1 : 1;
          const va = getPath(a.doc, f);
          const vb = getPath(b.doc, f);
          let c;
          if (va === undefined && vb === undefined) c = 0;
          else if (va === undefined) c = -1;
          else if (vb === undefined) c = 1;
          else c = compareValues(va, vb) || 0;
          if (c !== 0) return c * dir;
        }
        return a.seq - b.seq; // stable: insertion order
      });
    }
    entries = entries.slice(this._skip);
    if (this._limit > 0) entries = entries.slice(0, this._limit);
    return entries.map((e) => deepClone(e.doc));
  }
}

class InMemoryCollection {
  constructor(store, name) {
    this._store = store;
    this.collectionName = name;
    this._entries = []; // [{ seq, doc }] in insertion order
    this._indexes = new Map();
    this._resetIndexes();
  }

  _resetIndexes() {
    this._indexes.clear();
    this._indexes.set('_id_', { v: 2, key: { _id: 1 }, name: '_id_' });
  }

  _clear() {
    this._entries = [];
    this._resetIndexes();
  }

  _insert(input) {
    if (!isPlainObject(input)) throw new TypeError('document must be an object');
    const doc = deepClone(input);
    const seq = this._store._nextSeq();
    if (doc._id === undefined) doc._id = `mem_${String(seq).padStart(10, '0')}`;
    if (this._entries.some((e) => deepEqual(e.doc._id, doc._id))) throw duplicateKeyError(doc._id);
    this._entries.push({ seq, doc });
    return doc._id;
  }

  _applyUpdate(doc, update) {
    const ops = Object.keys(update || {});
    if (ops.length === 0 || ops.some((k) => k !== '$set')) {
      throw new Error('InMemoryStore: only $set updates are supported');
    }
    const before = deepClone(doc);
    for (const path of Object.keys(update.$set)) setPath(doc, path, update.$set[path]);
    return !deepEqual(before, doc);
  }

  _update(filter, update, options, many) {
    const hits = this._entries.filter((e) => matches(e.doc, filter));
    const targets = many ? hits : hits.slice(0, 1);
    const result = { acknowledged: true, matchedCount: targets.length, modifiedCount: 0, upsertedCount: 0, upsertedId: null };
    for (const entry of targets) {
      if (this._applyUpdate(entry.doc, update)) result.modifiedCount++;
    }
    if (targets.length === 0 && options && options.upsert) {
      const base = {};
      for (const key of Object.keys(filter || {})) {
        const cond = filter[key];
        if (!key.startsWith('$') && !isOperatorObject(cond)) setPath(base, key, cond);
      }
      this._applyUpdate(base, update);
      result.upsertedId = this._insert(base);
      result.upsertedCount = 1;
    }
    return result;
  }

  async insertOne(doc) {
    return { acknowledged: true, insertedId: this._insert(doc) };
  }

  /** ordered (default): stops at the first failure and throws; ordered:false continues and reports writeErrors. */
  async insertMany(docs, options = {}) {
    if (!Array.isArray(docs)) throw new TypeError('insertMany needs an array');
    const ordered = options.ordered !== false;
    const insertedIds = {};
    const writeErrors = [];
    docs.forEach((d, index) => {
      if (ordered && writeErrors.length) return;
      try {
        insertedIds[index] = this._insert(d);
      } catch (err) {
        writeErrors.push({ index, code: err.code, errmsg: err.message });
      }
    });
    const result = {
      acknowledged: true,
      insertedCount: Object.keys(insertedIds).length,
      insertedIds,
      writeErrors,
      hasWriteErrors: writeErrors.length > 0
    };
    if (ordered && writeErrors.length) {
      const err = new Error(writeErrors[0].errmsg);
      err.name = 'MongoBulkWriteError';
      err.code = writeErrors[0].code;
      err.result = result;
      throw err;
    }
    return result;
  }

  find(filter) {
    return new InMemoryCursor(this, filter);
  }

  async findOne(filter) {
    const entry = this._entries.find((e) => matches(e.doc, filter));
    return entry ? deepClone(entry.doc) : null;
  }

  async countDocuments(filter) {
    return this._entries.filter((e) => matches(e.doc, filter)).length;
  }

  async distinct(field, filter) {
    const out = [];
    for (const entry of this._entries) {
      if (!matches(entry.doc, filter)) continue;
      const raw = getPath(entry.doc, field);
      if (raw === undefined) continue;
      for (const v of Array.isArray(raw) ? raw : [raw]) {
        if (!out.some((x) => deepEqual(x, v))) out.push(deepClone(v));
      }
    }
    return out;
  }

  async updateOne(filter, update, options) {
    return this._update(filter, update, options, false);
  }

  async updateMany(filter, update, options) {
    return this._update(filter, update, options, true);
  }

  async deleteOne(filter) {
    const idx = this._entries.findIndex((e) => matches(e.doc, filter));
    if (idx === -1) return { acknowledged: true, deletedCount: 0 };
    this._entries.splice(idx, 1);
    return { acknowledged: true, deletedCount: 1 };
  }

  async deleteMany(filter) {
    const before = this._entries.length;
    this._entries = this._entries.filter((e) => !matches(e.doc, filter));
    return { acknowledged: true, deletedCount: before - this._entries.length };
  }

  /**
   * Supports insertOne / updateOne / deleteOne operations.
   * ordered:false continues past a failure and reports it in result.writeErrors
   * (no throw). ordered (default) stops at the first failure and throws an
   * error carrying the partial result in err.result.
   */
  async bulkWrite(operations, options = {}) {
    if (!Array.isArray(operations)) throw new TypeError('bulkWrite needs an array');
    for (const op of operations) {
      const kinds = Object.keys(op || {});
      if (kinds.length !== 1 || !['insertOne', 'updateOne', 'deleteOne'].includes(kinds[0])) {
        throw new TypeError(`InMemoryStore: unsupported bulkWrite operation ${kinds.join(',') || '(empty)'}`);
      }
    }
    const ordered = options.ordered !== false;
    const result = {
      acknowledged: true,
      insertedCount: 0,
      matchedCount: 0,
      modifiedCount: 0,
      deletedCount: 0,
      upsertedCount: 0,
      insertedIds: {},
      upsertedIds: {},
      writeErrors: [],
      hasWriteErrors: false
    };
    for (let index = 0; index < operations.length; index++) {
      const op = operations[index];
      try {
        if (op.insertOne) {
          result.insertedIds[index] = this._insert(op.insertOne.document);
          result.insertedCount++;
        } else if (op.updateOne) {
          const r = this._update(op.updateOne.filter, op.updateOne.update, { upsert: op.updateOne.upsert }, false);
          result.matchedCount += r.matchedCount;
          result.modifiedCount += r.modifiedCount;
          result.upsertedCount += r.upsertedCount;
          if (r.upsertedId !== null) result.upsertedIds[index] = r.upsertedId;
        } else {
          const r = await this.deleteOne(op.deleteOne.filter);
          result.deletedCount += r.deletedCount;
        }
      } catch (err) {
        result.writeErrors.push({ index, code: err.code, errmsg: err.message });
        result.hasWriteErrors = true;
        if (ordered) {
          const e = new Error(err.message);
          e.name = 'MongoBulkWriteError';
          e.code = err.code;
          e.result = result;
          throw e;
        }
      }
    }
    return result;
  }

  async createIndex(key, options = {}) {
    const spec = typeof key === 'string' ? { [key]: 1 } : deepClone(key);
    if (!isPlainObject(spec) || Object.keys(spec).length === 0) throw new TypeError('createIndex needs a key');
    const name = options.name || indexName(spec);
    if (!this._indexes.has(name)) {
      this._indexes.set(name, { v: 2, key: spec, name, ...deepClone(options) });
    }
    return name;
  }

  async indexes() {
    return Array.from(this._indexes.values()).map(deepClone);
  }

  /** Removes all documents and indexes; the handle stays valid. */
  async drop() {
    this._clear();
    return true;
  }
}

// ------------------------------------------------------------------ store

class InMemoryStore {
  constructor() {
    this._collections = new Map();
    this._counter = 0;
  }

  /** Monotonically increasing write counter (never decreases, not even on reset). */
  get counter() {
    return this._counter;
  }

  _nextSeq() {
    this._counter += 1;
    return this._counter;
  }

  collection(name) {
    if (typeof name !== 'string' || name.length === 0) throw new TypeError('collection name must be a non-empty string');
    if (!this._collections.has(name)) this._collections.set(name, new InMemoryCollection(this, name));
    return this._collections.get(name);
  }

  collectionNames() {
    return Array.from(this._collections.keys());
  }

  /** Empties every collection but keeps the collection objects registered, so held handles stay valid. */
  reset() {
    for (const col of this._collections.values()) col._clear();
  }
}

module.exports = { InMemoryStore };
