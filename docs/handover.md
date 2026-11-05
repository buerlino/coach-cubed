# Handover: releasing 0.1.0, and what is left for Noah

0.1.0 ([release-0.1.0.md](release-0.1.0.md)) is milestone A as a PWA at
https://coach-cubed.org. nordmu releases it from `buerlino/coach-cubed`, then
hands the repo and the domain to Noah. The workflow that builds and publishes
it: [`.github/workflows/pages.yml`](../.github/workflows/pages.yml); how it
works: the app's [Releasing: GitHub Pages](../app/README.md#releasing-github-pages).

## Releasing (nordmu, before the handover)

On `buerlino/coach-cubed`:

1. Settings → Pages: Source "GitHub Actions".
2. Verify coach-cubed.org in the owner's account (the account's Settings, not
   the repo's, → Pages → "Add a domain"): a TXT record
   `_github-pages-challenge-<login>` at Infomaniak.
3. The repo's custom domain: coach-cubed.org.
4. The apex DNS records GitHub documents (A and AAAA; `www` as a CNAME to
   `<login>.github.io`), see
   [Managing a custom domain](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site).
5. A manual run of the workflow with `deploy` off (Actions → Pages → Run
   workflow): the build must pass on GitHub before the tag (the Kaggle download
   can't be tested from the laptop).
6. The `github-pages` environment's tag rule. The environment exists once
   Pages' source is "GitHub Actions" (or after the first run) and by default
   allows only `main`, so a run on a tag is refused at the deploy ("Tag v0.1.0
   is not allowed to deploy to github-pages due to environment protection
   rules"). Settings → Environments → github-pages → add a tag rule `v*`, or
   `gh api repos/<owner>/<repo>/environments/github-pages/deployment-branch-policies -f type=tag -f name='v*'`.
7. `git tag -a v0.1.0 -m "…"` on `main`, and push the tag; the workflow builds,
   tests and deploys (Actions tab).
8. "Enforce HTTPS" once the certificate is issued.
9. A smoke test on a phone: install, airplane mode, analyse an example clip.

## The handover

1. nordmu removes the verified domain from his account (while it is verified
   there, only his own repos can publish to it, and nobody else can verify it).
2. nordmu transfers the repo (releases, tags, settings and secrets transfer;
   github.io URLs aren't redirected).
3. Noah accepts.
4. The domain moves to Noah's Infomaniak account: a screenshot of the DNS zone
   before, compared after.
5. Noah verifies the domain in his account with his own TXT record, and the
   old TXT record is removed.
6. Check https://coach-cubed.org; if it is down, run the Pages workflow once
   (Actions → Run workflow).
7. Branch protection on `main` (question 9 below).

If the domain ever moves to another registrar, recreate the zone there first
and remove the DNSSEC DS record first.

**A later release:** bump the version (`app/package.json` and `APP_VERSION` in
`app/src/store/store.mjs`; a test keeps them equal), merge to `main`, tag
`vX.Y.Z`, push the tag. The workflow refuses a tag that is not
`app/package.json`'s version.

## What is left

The queue is [packages/](packages/README.md); each package below has its file
there with the history and what is known. All are held for Noah, after 0.1.0
(nordmu, 2026-11-04). The phone packages need the Fairphone 6 (the S8+ for
`c60`) and the pipeline ([pipeline.md](pipeline.md)).

| Package | What | File |
| --- | --- | --- |
| `c30` | The camera on the Fairphone: the permission, the real rate, the ring's memory. Merged, with two gaps: four sets short of five runs, the PWA window not tried. | [c30.md](packages/c30.md) |
| `c30b` | Recording and analysis together on the Fairphone: a job beside recording, the screen kept on, the app in the background. | [c30b.md](packages/c30b.md) |
| `c60` | Milestone A on the Samsung S8+ (Android 9, Chrome 101 as the WebView): the PWA, `c65`'s probe and fallbacks on the phone. | [c60.md](packages/c60.md) |
| `c64` | The stepper's decoder holds at most a few frames on the phone (`c26`: 10–14 open). | [c64.md](packages/c64.md) |
| `c31` | A session on the Fairphone, 30–60 minutes: heat, battery, storage, memory. | [c31.md](packages/c31.md) |
| Checkpoint B | nordmu runs a real gym session (after `c31`). | [queue](packages/README.md) |
| `c33` | The tester APK: the real name and package ID (`io.github.noahsta.coachcubed`), release signing. No file yet; needs the signing key's holder. | [queue](packages/README.md), [app-plan.md](app-plan.md#toward-the-public-010-phase-6-not-yet-packages) |
| `c40` | The pipeline runnable for Noah: nothing in `pipeline/`, `.claude/` or the phone scripts may assume nordmu's laptop. No file yet; written after checkpoint B. | [app-plan.md](app-plan.md#toward-the-public-010-phase-6-not-yet-packages) |

Also in app-plan.md's section: WebGPU, the validation set (steps 3.0 and 3.6),
the F-Droid recipe trial, and step 5.8 (park the old page or keep a trimmed
viewer). To add a cue or a lift: [lifts.md](lifts.md).

## Questions for Noah

From [decisions.md](decisions.md#needs-an-answer), as they stand:

- **2**, where 0.1.0 is published: nordmu decided it (a PWA at coach-cubed.org;
  the APK and F-Droid later); Noah may revise it.
- **5**, `.auth_password`: is that password used anywhere else? Change it there.
- **6**, how long the restructuring window lasts (the history rewrite, step
  2.8, has to finish before Noah resumes).
- **9**, branch protection on `main` of the repo: turn it on.
- **10**, the app's name and the domain: Coach Cubed and coach-cubed.org are
  set; the trademark search is still open ([branding.md](branding.md)).
