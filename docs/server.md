# The server (dev tooling)

The Flask app (`src/app.py`), its launch scripts (`scripts/`) and the Caddy
deploy on Noah's machine. Since 2026-10-31 the server is dev tooling: it
produces reference tracks and goldens with ViTPose, and the app itself must
not depend on it ([rules-core.md](rules-core.md)). These rules came out of
[AGENTS.md](../AGENTS.md) in step 2.1 and bind anyone who changes how the
server is served, launched, or what it loads. [deploy.md](deploy.md) describes
the deploy too, but is stale in places (see [map.md](map.md), area 10); where
the two differ, this file and the scripts win.

## Test under the real path prefix

coach is not served at the site root. The real deploy (`~/Caddyfile` on
Noah's machine, *not* the `Caddyfile` copy in this repo) mounts it at
`/coach/*` via `handle_path`, which **strips the prefix before Flask ever sees
the request**. That is why every asset path has to be relative (AGENTS.md §1).

Testing against `http://127.0.0.1:8080/` is not sufficient: it passes even
when the production URL is broken. Test through the proxied path
(`https://coach-host.example-tailnet.ts.net/coach/...`). Without access to that box,
the stand-in is a small proxy that strips `/coach` and forwards to the app;
step 2.0 was tested that way.

## Landmines

- **Two Caddyfiles exist.** The repo's own `Caddyfile` is a single-site
  config kept for reference; the *live* one is `~/Caddyfile` (outside this
  repo), which mounts coach, tecna and llm-server together under path
  prefixes on the same box. `docs/deploy.md` describes the older single-site
  shape and is stale on this point — when in doubt about how a request
  actually reaches this app, read `~/Caddyfile`, not `docs/deploy.md`.
- **`.caddy/` holds the live CA.** Never delete or regenerate it — every
  device that already trusts it (phones, laptops on the tailnet) would need
  to re-install a new root cert. Treat it like a production secret.
- **`diagnostics.js` is read per request; `app.py` is not.** A JS-only edit
  needs only a browser reload. A Python edit needs the backend restarted
  (`./scripts/restart.sh`) before it takes effect — don't mistake a stale
  process for a bug in your change.

## You are not alone on this box: keep your sibling notes current

The deploy is one of several web services on the same machine, behind one
shared HTTPS gateway, sharing one GPU and 22 GiB of RAM. You would not know
that from reading this repo, and **that is deliberate**: nothing here names
another service, because every cross-reference that got written turned stale
within weeks and actively misled whoever read it next. Keeping the coupling
out means this app still runs correctly alone, at the root, unmodified.

The knowledge has to live somewhere, though, and that somewhere is
**`../new-service.md`** on that machine: the tutorial for adding a service
there, plus a *sibling notes* registry with one entry per service.

**Your obligation.** If you change anything a sibling could trip over, update
this project's entry in that file **in the same change**:

- the port it binds, or any port it pins for a subprocess
- its measured peak VRAM or peak host RAM (measure with `~/gpu.sh` and
  `~/ram.sh` under real load — write down what you saw, not an estimate)
- how it can be made to release GPU memory, and how to verify that worked
- anything it registers in the shared layer (`~/Caddyfile`, `~/gpu.sh`,
  `~/ram.sh`, `~/serve_all.sh`)
- a URL that external clients bake in and that therefore cannot move
- long GPU submissions, or a host-side buffer as large as its model

Do **not** write any of that into this repo's own docs. A sibling-aware note
here is the bug this split exists to prevent.

Read that file before changing how this app is served, how it loads models,
or what it holds. The GPU and RAM rules there are not general advice — they
are measured properties of that box, including several that contradict what
the tooling reports.
