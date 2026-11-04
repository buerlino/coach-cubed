# Name and logo

The app's name and its logo, both open: what is required, what was checked,
and what the logo has to deliver. The decision itself waits in
[decisions.md](decisions.md#needs-an-answer) (question 10). Rewrite in
place.

## The name

- **Required (nordmu, 2026-11-01):** it keeps "coach", and the part with it
  is invented, something new: not a short English word.
- **Plain "coach" is advised against.** Search engines bury it under the
  fashion brand and every coaching app. COACH is a famous trademark
  (Tapestry), protected even outside its own goods, so a complaint later
  forces a rename and a reinstall for every user. And a generic word can't
  be defended. F-Droid has no "Coach" app, but F-Droid is the last of the
  three channels.
- **English words plus "coach" are taken:** the AI-coach wave of 2025–26
  used them up (the table below). Invented words are the ones still free.
- **The package ID** (the reverse of the app's domain, say) is fixed
  before the first APK goes to testers: Obtainium ties updates to the
  package ID and the signing key, so changing it later means a reinstall.
- **nordmu's pick (2026-11-02): coach³, "Coach Cubed".** Cubed as in
  volume, since muscles are volumes, and training volume (sets × reps ×
  weight) is how lifters count work. Written "Coach Cubed" wherever text is
  typed or searched (stores, domain, package ID); the ³ belongs to the
  wordmark and the logo. Clean where checked (the table below).
- **Next:** Noah's view, a manual trademark search (the distinct part is
  "Cubed", so ask whether the COACH mark is in the way), and the domain.

## What was checked (2026-11-01)

How: Google Play search (the first 15–25 results; longer lists were cut
off), the App Store through the iTunes Search API, F-Droid search, GitHub,
the domains through RDAP, and a web search for the last round. TMview
(EUIPO) and the USPTO search block automated requests, so no trademark
register was searched: do it by hand in TMview, the USPTO trademark search
and WIPO's Global Brand Database, Nice classes 9 (apps), 41 (coaching) and
42 (software services).

| Name | Already used by | Free domains | Verdict |
| --- | --- | --- | --- |
| **Coach³, "Coach Cubed"** (nordmu) | nothing found; the nearest is a Rubik's toy, the "Coach Cube"; typed "coach3" it meets two unrelated apps | coachcubed.com, coachcubed.app, cubed.coach, coach3.app | clean; nordmu's pick |
| Halterocoach (*haltero-*: weightlifting in French, Spanish, Portuguese) | nothing found | haltero.coach, halterocoach.com, .app | clean |
| Coachgeist (German *Geist*: spirit, ghost) | nothing found | coachgeist.com, .app | clean |
| Skelecoach (the skeleton you see) | nothing found | skele.coach, skelecoach.com, .app | clean |
| Coachimedes (Archimedes' lever: every lift is levers) | nothing found | coachimedes.com, .app | clean |
| Coachilles (Achilles, the hero and the tendon) | nothing found (Coachilla, a closed Finnish marketplace, is the nearest) | coachilles.com, .app | clean |
| Coach² ("coach squared", nordmu) | nothing as "Coach Squared"; typed "coach2" it meets five Play apps (PE Coach 2, Coach2Competence, ...) | none: coachsquared.com, .app and coach2.app are taken; a ² can't go in a domain or package ID | weak as the name, and still the bare COACH mark; usable as a logo treatment |
| Kinemacoach | KinemaCoach, an AI posture-analysis platform | all three | out |
| Arthrocoach | arthrocoach.com (since 2013), a GitHub repo | arthro.coach, .app | weak |
| Coachmetry, Coachalot, Biomechcoach | no app; each .com registered | each .app | weak |
| CueCoach | an AI coaching product on cuecoach.app and .com, and other sites | .io, .de, .eu | out (nordmu) |
| Open Lift Coach | openlift.coach (found by nordmu) | – | out |
| TapeCoach | Tape Coach, a site to "upload and review training video" | none | out |
| KnurlCoach | Knurl (knurl.coach), software for barbell coaches | .com, .app | out |
| BraceCoach, GrooveCoach | no app | brace.coach, .app; groove.coach | clean, but short English words |
| Kinocoach | a small GitHub repo; "kino" means cinema | kino.coach | clean, but unclear in English |
| Stickcoach, Chalkcoach, Ghostcoach | no app; crowded searches, sounds like stickK | stick.coach only | weak |
| LiftCoach, RepCoach, PoseCoach, IronCoach, RackCoach, FormCoach | several apps each, in fitness | few or none | out |
| ReplayCoach, MirrorCoach, SlomoCoach, PlateCoach | an app with that name or nearly | some | out |

## The logo

**The symbol arrived on 2026-11-03:** a green C with a fist in its bowl
and an orange ³, as Android's two adaptive-icon layers on the 108-unit
grid, `logo/coach-cubed_front.svg` (the symbol) and
`logo/coach-cubed_back.svg` (the ground). Its colours: ground `#0E3B1E`,
C `#47CA27`, ³ `#EF7F00`, white outlines. `app/tools/make-icon.mjs`
renders every icon below from the two files; rerun it when they change.

**nordmu drew it** (Affinity Designer; the source is
`logo/coach-cubed.afdesign`) and licensed it CC BY-SA 4.0 (2026-11-03,
recorded in [THIRD_PARTY.md](../THIRD_PARTY.md) and the in-app credits).
**Still open:** the wordmark (the name set as artwork).
Checked against the list below: the symbol fits Android's safe circle (the
³ touches its edge), the C³ reads at 48 px, and the fist's lines blur into
texture below about 96 px, which is fine. The one-colour layer is derived
by the script (every colour to one, the fist kept as lines); nordmu may want
to draw one by hand.

**What the symbol has to survive:**

- 48 px on a home screen and 16 px in a browser tab: bold shapes, no thin
  lines, no text, no fine detail.
- Cropping to a circle, a squircle or a rounded square, depending on the
  phone: everything that matters fits in the middle 60% of the square.
- Two layers for Android: the symbol and a background (a flat colour will
  do), plus a one-colour silhouette for Android's themed icons.
- Dark and light backgrounds: the app is dark; GitHub and F-Droid pages are
  often light.
- A licence: the artist's written OK and a licence such as CC BY-SA 4.0,
  recorded in [THIRD_PARTY.md](../THIRD_PARTY.md). The logo ships in the
  app, and F-Droid checks what ships.

**Generated from them** (by the script, not by hand):

| Where | Files | Status |
| --- | --- | --- |
| The Android APK | the two-layer icon and its one-colour layer, every launcher size (48–192 px), the splash-screen icon | done |
| The PWA | 192 and 512 px icons, a maskable 512 px one, the browser-tab icon (SVG and 32 px) | done |
| The iPhone home screen | a 180 px icon | done |
| F-Droid and GitHub releases | a 512 px icon (`logo/coach-cubed-512.png`); optionally a 1024×500 banner | icon done |
| In the app | the wordmark in the header and on the About screen | waits for the wordmark |
