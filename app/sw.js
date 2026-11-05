// SPDX-License-Identifier: AGPL-3.0-or-later
// The service worker (package c19): the app offline. A classic script, scope
// ./ (where it is served from; no host and no absolute path in it).
//
// - install: fetches files.json (assemble.mjs's list of every file in dist/
//   and a version hash), then every file in it, into the cache coach-<version>.
//   One missing file fails the whole install, loudly: a half-filled cache is
//   removed, the old worker goes on, and the browser tries again at its next
//   update check. A new version installs next to the old one's cache and
//   waits: it never skips the waiting by itself.
// - message {type: 'skip-waiting'}: the page (src/updates.mjs) sends it once
//   the analysis queue is idle, so an update never lands under a running job.
// - activate: removes every other coach-* cache, then takes the open pages.
// - fetch: a GET to this origin, inside the scope, is answered from this
//   version's cache, never from the network; anything else (other origins,
//   other methods, a file not in the list) is left to the browser, and
//   nothing outside files.json is ever stored.
//
// assemble.mjs stamps the version into the copy in dist/ (the next line), so
// the file's bytes change with every version: that is what makes the browser
// look for an update at all. The repo's copy has no version and refuses to
// install.
'use strict';

const BUILT_VERSION = null;
const PREFIX = 'coach-';
const FETCHES_AT_ONCE = 6;

const scopeUrl = new URL(self.registration.scope);
const urlOf = rel => new URL(rel, scopeUrl).href;
const cacheName = () => PREFIX + BUILT_VERSION;

async function readList() {
  const res = await fetch(urlOf('files.json'), { cache: 'no-store' });
  if (!res.ok) throw new Error(`files.json: ${res.status}`);
  let list;
  try { list = await res.json(); } catch { throw new Error('files.json: not JSON'); }
  if (!list || typeof list.version !== 'string' || !Array.isArray(list.files)
    || !list.files.every(f => typeof f === 'string' && f !== '')) {
    throw new Error('files.json: no version and list of files');
  }
  for (const f of list.files) {
    if (f.startsWith('/') || f.split('/').includes('..') || /^[a-z]+:/i.test(f)) {
      throw new Error(`files.json: ${f} is not a path inside the app`);
    }
  }
  return list;
}

async function precache() {
  if (typeof BUILT_VERSION !== 'string') throw new Error('sw.js has no version stamp: use the copy assemble.mjs wrote to dist/');
  const list = await readList();
  if (list.version !== BUILT_VERSION) {
    throw new Error(`sw.js is version ${BUILT_VERSION} but files.json lists ${list.version}: the files are not all from one build`);
  }
  const name = cacheName();
  const cache = await caches.open(name);
  const todo = [...list.files];
  try {
    const worker = async () => {
      for (let f = todo.shift(); f !== undefined; f = todo.shift()) {
        // 'reload': the HTTP cache may hold an older file under the same name
        const res = await fetch(urlOf(f), { cache: 'reload' });
        if (!res.ok) throw new Error(`${f}: ${res.status}`);
        await cache.put(urlOf(f), res);
      }
    };
    await Promise.all(Array.from({ length: FETCHES_AT_ONCE }, worker));
    await cache.put(urlOf('files.json'), new Response(JSON.stringify(list), { status: 200, headers: { 'content-type': 'application/json' } }));
  } catch (e) {
    todo.length = 0;
    await caches.delete(name);
    throw new Error(`coach ${BUILT_VERSION}: install failed on ${e && e.message ? e.message : e}`);
  }
}

async function dropOld() {
  for (const name of await caches.keys()) {
    if (name.startsWith(PREFIX) && name !== cacheName()) await caches.delete(name);
  }
  await self.clients.claim();
}

// The cached answer for a request, or undefined: let the network have it.
async function fromCache(request) {
  if (typeof BUILT_VERSION !== 'string' || !(await caches.has(cacheName()))) return undefined;
  const cache = await caches.open(cacheName());
  const url = new URL(request.url);
  url.hash = '';
  if (url.pathname.endsWith('/')) url.pathname += 'index.html';
  url.search = '';
  return cache.match(url.href);
}

self.addEventListener('install', event => { event.waitUntil(precache()); });
self.addEventListener('activate', event => { event.waitUntil(dropOld()); });
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'skip-waiting') self.skipWaiting();
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== scopeUrl.origin || !url.pathname.startsWith(scopeUrl.pathname)) return;
  event.respondWith(fromCache(request).then(hit => hit || fetch(request)));
});
