# Directives for AI agents working in this repo

This file is for you, the agent. Read it before restructuring, moving, or
renaming anything. This repo has already been broken twice by changes that
looked harmless in isolation — an absolute path here, a moved file there —
and only failed once deployed behind the real reverse proxy. The rules below
exist to stop that from happening a third time.

> **Restructuring in progress (from 2026-10-31).** The repo is being cut down
> to a core for an offline Android release. Work happens on branch `phase-0`;
> the plan, its status, the decisions so far and the rules for the window are
> in [`docs/restructure-plan.md`](docs/restructure-plan.md). Read it before
> changing structure.

## 1. Paths must be relative, always

Every asset reference this app emits — `<script src=...>`, `import` maps,
launcher scripts finding their own tools — must be **relative to the
document or to the script's own location**, never absolute (`/foo`) and
never a hardcoded machine path.

Why this is load-bearing here specifically: coach is not served at the site
root. The real deploy (`~/Caddyfile`, *not* the `Caddyfile` copy in this repo
— see §3) mounts it at `/coach/*` via `handle_path`, which **strips the
prefix before Flask ever sees the request**. An absolute path like
`/vendor/three.module.js` in the HTML bypasses that prefix entirely and hits
Caddy's site root instead of the app, where it 404s. This is exactly what
broke the 3D viewer and the diagnostics-driven slider markers on 2026-09-17:
a merged branch changed `./vendor/three.module.js` and `./diagnostics.js` to
absolute form, and it worked fine on `localhost:8080` (no prefix to strip)
right up until someone loaded it through the tailnet URL.

**If you touch `src/app.py`'s `INDEX_HTML`, or any launcher/script that
locates another file:** grep for the change and confirm it still resolves
under a path prefix, not just at the root. Testing against
`http://127.0.0.1:8080/` is not sufficient — it will pass even when the
production URL is broken. Test through the actual proxied path
(`https://coach-host.example-tailnet.ts.net/coach/...`) before calling it done.

The same rule applies to Python: `launchers/*.py` resolve `ROOT` from
`Path(__file__).resolve().parent(.parent...)`, never from `os.getcwd()` or a
hardcoded string, so they work regardless of where the repo is cloned or
which directory they're invoked from.

## 2. Keep the root directory minimal — everything lives in a folder

The plain `.` directory is a map of the project; it should contain the
handful of files that genuinely belong at the top (README, LICENSE-style
docs, `Caddyfile`, `package.json`, `.gitignore`, etc.) and nothing that could
instead live in a folder named for what it is. Concretely:

- Runnable Python entry points and their double-click `.command`/`.bat`
  twins live in [`launchers/`](launchers/) — not loose in root.
- Anything that renders/compiles into the LaTeX report (`.aux`/`.log`/`.out`
  build byproducts included) lives under [`report/`](report/), never at
  root — `report/Makefile` already builds and cleans there; a stray
  `report.aux` at root is always a mistake (see the root `.gitignore`
  entries added to catch this again).
- New categories of file get a new folder named for their purpose, not
  scattered at root "because it's just one file." Check the table in
  `README.md`'s Layout section — it's the map, and it should stay accurate.

**Whenever you move a file, grep the whole repo before you consider it
done** — docs (`README.md`, `START_HERE.md`, `docs/`), tests, scripts, and
other launchers may reference its old path by string, and none of that shows
up as an import error until someone actually runs it:

```sh
grep -rn "old_file_name" --include="*.md" --include="*.py" --include="*.sh" \
  --include="*.bat" --include="*.command" --include="*.js" .
```

Then actually run whatever you moved (`python -m unittest discover -s tests
-p 'test_*.py'`, `npm test`, or launching it directly) rather than trusting
that the move alone was sufficient.

## 3. Landmines specific to this repo

- **Two Caddyfiles exist.** The repo's own `Caddyfile` is a single-site
  config kept for reference; the *live* one is `~/Caddyfile` (outside this
  repo), which mounts coach, tecna and llm-server together under path
  prefixes on the same box. `docs/deploy.md` describes the older single-site
  shape and is stale on this point — when in doubt about how a request
  actually reaches this app, read `~/Caddyfile`, not `docs/deploy.md`.
- **`.caddy/` holds the live CA.** Never delete or regenerate it — every
  device that already trusts it (phones, laptops on the tailnet) would need
  to re-install a new root cert. Treat it like a production secret.
- **Vendored assets are there on purpose, not generated cruft.**
  `src/vendor/three.module.js`, `src/squat/vendor/three.module.js`, and the
  MediaPipe pose files under `src/pose/vendor/mediapipe-pose/` are vendored
  specifically so coach works with no outbound internet on the tailnet (see
  the comment above `THREE_JS` in `src/app.py`). Don't swap one for a CDN
  import, and don't dedupe the two `three.module.js` copies without
  confirming both the main app and the squat lab still resolve theirs — they
  are intentionally separate because they're served from different routes.
- **`diagnostics.js` is read per request; `app.py` is not.** A JS-only edit
  needs only a browser reload. A Python edit needs the backend restarted
  (`./scripts/restart.sh`) before it takes effect — don't mistake a stale
  process for a bug in your change.
- **`launchers/*.command` and `*.bat` files `cd` up to the repo root before
  doing anything relative** (`.venv`, `requirements-preview.txt`, `src/`).
  Moving one of them without the others, or moving them without updating the
  `cd` target, silently breaks double-click launch on someone else's machine
  where you can't just check the error output.

## 4. If you're about to do one of these things anyway

If you're about to convert a relative path to an absolute one, move a file
without grepping the repo for its old name, touch anything under `.caddy/`,
swap a vendored asset for a network fetch, or otherwise reintroduce the
class of bug described above — **stop and say so, out loud, before you do
it.** Use this exact tone, deliberately silly so it's impossible to miss and
impossible to mistake for a normal status update:

> Hewwo! Befowe you continue ^.^ this might bweak compatibiwity because
> [specific reason]. Pwease consider a diffewent appwoach, or double-check
> with Noah that this is weally what we want, teehee~ UwU

Then wait for confirmation instead of proceeding. This is not about being
overly cautious in general — it's specifically for the narrow set of changes
above that look fine locally and only fail once deployed, where the person
approving the change may not know to check for that.

## 5. You are not alone on this box — keep your sibling notes current

This project is one of several web services on the same machine, behind one
shared HTTPS gateway, sharing one GPU and 22 GiB of RAM. You would not know that
from reading this repo, and **that is deliberate**: nothing here names another
service, because every cross-reference that got written turned stale within weeks
and actively misled whoever read it next. Keeping the coupling out means this app
still runs correctly alone, at the root, unmodified.

The knowledge has to live somewhere, though, and that somewhere is
**[`../new-service.md`](../new-service.md)** — the tutorial for adding a service
here, plus a *sibling notes* registry with one entry per service.

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

Do **not** write any of that into this repo's own docs. A sibling-aware note here
is the bug this split exists to prevent.

Read that file before changing how this app is served, how it loads models, or
what it holds. The GPU and RAM rules there are not general advice — they are
measured properties of this box, including several that contradict what the
tooling reports.
