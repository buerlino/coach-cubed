// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// An in-memory fake of the OPFS calls the store uses (app/src/store/), for
// tests/app/store.test.js only: navigator.storage's getDirectory(), persist(),
// persisted() and estimate(), and the directory and file handles under it
// (getDirectoryHandle, getFileHandle, removeEntry, entries, getFile,
// createWritable with write/close/abort, move). It follows the real API where
// the store depends on it:
//  - a writable stages its data and commits on close(); abort() throws it away;
//  - a write that would take the origin past its quota throws a DOMException
//    named QuotaExceededError (what Chromium throws on a full disk);
//  - removeEntry on a folder with content needs { recursive: true };
//  - move(name) renames a file inside its folder, replacing the target.
// `ops` logs each change ('write', 'move', 'remove', 'mkdir') for tests that
// assert the order of events.

class FakeFile extends Blob {
  constructor(parts, name, options) {
    super(parts, options);
    this.name = name;
    this.lastModified = Date.now();
  }
}

function domError(name, message) {
  return new DOMException(message, name);
}

function createFakeStorage({ quota = 1e9, persistGrant = true } = {}) {
  const ops = [];
  const calls = { persist: 0, estimate: 0, getDirectory: 0 };
  const state = { quota, persisted: false, persistGrant };
  const rootNode = { kind: 'directory', children: new Map() };

  const used = (node = rootNode) => {
    let n = 0;
    for (const c of node.children.values()) n += c.kind === 'directory' ? used(c) : c.data.size;
    return n;
  };

  function dirHandle(node, name, path) {
    return {
      kind: 'directory',
      name,
      async getDirectoryHandle(child, { create = false } = {}) {
        let c = node.children.get(child);
        if (c && c.kind !== 'directory') throw domError('TypeMismatchError', `${child} is a file`);
        if (!c) {
          if (!create) throw domError('NotFoundError', `${path}${child} not found`);
          c = { kind: 'directory', children: new Map() };
          node.children.set(child, c);
          ops.push(['mkdir', `${path}${child}`]);
        }
        return dirHandle(c, child, `${path}${child}/`);
      },
      async getFileHandle(child, { create = false } = {}) {
        let c = node.children.get(child);
        if (c && c.kind !== 'file') throw domError('TypeMismatchError', `${child} is a directory`);
        if (!c) {
          if (!create) throw domError('NotFoundError', `${path}${child} not found`);
          c = { kind: 'file', data: new Blob([]) };
          node.children.set(child, c);
        }
        return fileHandle(node, child, path);
      },
      async removeEntry(child, { recursive = false } = {}) {
        const c = node.children.get(child);
        if (!c) throw domError('NotFoundError', `${path}${child} not found`);
        if (c.kind === 'directory' && c.children.size && !recursive) {
          throw domError('InvalidModificationError', `${path}${child} is not empty`);
        }
        node.children.delete(child);
        ops.push(['remove', `${path}${child}`]);
      },
      async *entries() {
        for (const [k, c] of [...node.children]) {
          yield [k, c.kind === 'directory' ? dirHandle(c, k, `${path}${k}/`) : fileHandle(node, k, path)];
        }
      },
      async *keys() { for (const k of [...node.children.keys()]) yield k; },
      async *values() { for await (const [, h] of this.entries()) yield h; },
      [Symbol.asyncIterator]() { return this.entries(); },
    };
  }

  function fileHandle(parent, name, path) {
    return {
      kind: 'file',
      name,
      async getFile() {
        const c = parent.children.get(name);
        if (!c) throw domError('NotFoundError', `${path}${name} not found`);
        return new FakeFile([c.data], name, { type: c.data.type });
      },
      async createWritable() {
        let staged = new Blob([]);
        let closed = false;
        return {
          async write(data) {
            if (closed) throw new TypeError('writable is closed');
            const part = data instanceof Blob || typeof data === 'string' || ArrayBuffer.isView(data) || data instanceof ArrayBuffer
              ? data : (() => { throw new TypeError('write(): unsupported data'); })();
            const next = new Blob([staged, part]);
            const c = parent.children.get(name);
            const others = used() - (c ? c.data.size : 0);
            if (others + next.size > state.quota) {
              throw domError('QuotaExceededError', 'The origin is over its quota');
            }
            staged = next;
          },
          async close() {
            if (closed) throw new TypeError('writable is closed');
            closed = true;
            const c = parent.children.get(name);
            if (!c) throw domError('NotFoundError', `${path}${name} was removed`);
            c.data = staged;
            ops.push(['write', `${path}${name}`]);
          },
          async abort() { closed = true; },
        };
      },
      async move(...args) {
        // Chromium: move(name) renames in place; move(dir, name) moves.
        if (args.length !== 1 || typeof args[0] !== 'string') throw new TypeError('fake move(name) only');
        const target = args[0];
        const c = parent.children.get(name);
        if (!c) throw domError('NotFoundError', `${path}${name} not found`);
        parent.children.delete(name);
        parent.children.set(target, c);
        ops.push(['move', `${path}${name}`, `${path}${target}`]);
      },
    };
  }

  const root = dirHandle(rootNode, '', '');

  const storage = {
    async getDirectory() { calls.getDirectory++; return root; },
    async persist() { calls.persist++; state.persisted = state.persisted || state.persistGrant; return state.persisted; },
    async persisted() { return state.persisted; },
    async estimate() { calls.estimate++; return { usage: used(), quota: state.quota }; },
  };

  // Test helpers: read and change the tree without going through the handles.
  const walk = (segs) => {
    let n = rootNode;
    for (const s of segs) { n = n && n.children && n.children.get(s); }
    return n || null;
  };
  const helpers = {
    ops, calls, state,
    used: () => used(),
    setQuota(q) { state.quota = q; },
    /** The file at 'a/b/c.json' as text, or null. */
    text(p) { const n = walk(p.split('/')); return n && n.kind === 'file' ? n.data.text() : null; },
    exists(p) { return walk(p.split('/')) !== null; },
    /** Every path under the root, files and folders ('lifts/x/', 'lifts/x/cut.mp4'), sorted. */
    paths() {
      const out = [];
      const rec = (n, p) => {
        for (const [k, c] of n.children) {
          if (c.kind === 'directory') { out.push(`${p}${k}/`); rec(c, `${p}${k}/`); } else out.push(`${p}${k}`);
        }
      };
      rec(rootNode, '');
      return out.sort();
    },
    /** Put a file in place (creating folders), bypassing the quota: damage, old data. */
    put(p, data) {
      const segs = p.split('/');
      const file = segs.pop();
      let n = rootNode;
      for (const s of segs) {
        if (!n.children.has(s)) n.children.set(s, { kind: 'directory', children: new Map() });
        n = n.children.get(s);
      }
      n.children.set(file, { kind: 'file', data: new Blob([data]) });
    },
    remove(p) {
      const segs = p.split('/');
      const last = segs.pop();
      const parent = walk(segs);
      if (parent) parent.children.delete(last);
    },
  };
  return { storage, ...helpers };
}

module.exports = { createFakeStorage };
