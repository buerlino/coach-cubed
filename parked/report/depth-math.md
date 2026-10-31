# How the 3D depth is computed

ViTPose gives 2D joints `(x, y)` only. Everything below is the recovery of the
missing `z`. Implemented in `src/depth_backend.py`.

The same material, typeset with real figures and measured on the example clip,
is **Appendix A of `report.pdf`** (`make`). This file is the quick version.

---

## 1. Foreshortening → depth

**Formula**

```
dz = sqrt( max(L² − l², 0) )
```

`L` = the segment's true 3D length (a prior), `l` = its measured 2D length on
screen. Assumes an orthographic camera, so the segment's screen length is just
its projection.

**Intuition** — a bone of fixed length that looks *short* on screen must be
pointing partly at the camera. The shortfall is the depth.

```
        camera
          |                 side view of one bone
          v
   parent o------------o child      l  (what we see)
          o                          \
           \                          \   L (what it is)
            \  dz  (what's missing)    \
             o . . . . . . . . . . . . . o
             <----------- l ------------>

   Pythagoras:  L² = l² + dz²
```

If `l > L` the sqrt is clamped to 0 — the joint is placed flat rather than
raising an error.

Priors `L` are fractions of torso length (`_BONE_RATIO`): thigh and shank 0.85,
upper arm 0.62, forearm 0.50. Joints are placed by walking outward from the
trunk (`_WALK`), each child's `z` = parent's `z` ± `dz`.

**The head is one point, not five.** COCO gives nose + 2 eyes + 2 ears; the lift
keeps a single point at the **midpoint of the two eyes** and drops the rest —
five points inside a head's width resolve nothing, and they were 4 of the 13
direction toggles. It is *not* walked from the neck: neck→eyes isn't rigid (the
athlete looks down in the pull), projecting 0.37 torso at the median vs 0.59 at
its longest, so a prior covering the 0.59 would invent
`sqrt(0.62² − 0.37²) = 0.50` torso of depth at a typical frame. The head sits on
the sagittal **midline**, where `z = 0` is right by construction — no prior, no
sign to choose, follows the trunk.

---

## 2. Scale — what "1 unit" means

Two sources, in order of preference:

**A. Plate (metric, mm).** A bumper plate is 450mm. Fit an ellipse to the
detected plate; its **major** semi-axis is the least-foreshortened radius:

```
s  =  225mm / (major/2)          →  millimetres per pixel
```

**B. Torso (relative).** No plate → use pelvis→neck distance in pixels as the
unit. Everything is then "in torso lengths", which is enough for angles and
shape but not for absolute measurements.

One scale **per clip**, not per frame (`Scene.clip_torso_px`). The per-frame
pelvis→neck distance is a *projection* — 141 px at the bottom of the pull vs
251 px stood up on the test lift, 1.78× — while the real torso doesn't change
length. Scaling the bone priors by it shrinks every bone exactly when the pose
is most foreshortened, and only the bones, since `x`/`y` stay in real pixels.
A projection is never longer than what it projects, so every per-frame value is
a lower bound on one fixed number and the largest wins; we take p95, the top of
that distribution being keypoint noise. Assumes a fixed camera distance.

The plate also gives the **bar's tilt out of the screen**, because a circle
seen at angle α projects to an ellipse:

```
   face-on              tilted by α
    _____                 _____
   /     \               /     \        minor/major = cos α
  |   O   |             (   O   )
   \_____/               \_____/        so  cos α = minor/major
   maj=min              minor < major   and the bar axis is
                                        (sinα·bar_dir, −cosα)
```

That is the only true 3D anchor in the system: it fixes a real distance *and* a
real orientation from one frame.

---

## 3. The sign ambiguity — the hard part

`dz` has a magnitude but **no sign**. A bone foreshortened by 30px is equally
consistent with bending toward the camera or away from it.

```
                        o child (toward)
                       /
        parent o------o------ screen plane
                       \
                        o child (away)

   Both project to exactly the same 2D pose.
```

With `n` such joints there are `2ⁿ` reconstructions that fit the image
*perfectly*. We search 9 free bits — torso twist, both elbows, both wrists,
both knees, both ankles — so 512 candidates. (§6 is why the distal four can't
be folded into their parents.)

**Mirror symmetry.** Flipping *every* sign reflects the whole body about the
screen plane. That preserves every pairwise distance, so no distance-based
score can ever tell the two apart. The 512 candidates are really **256 poses,
each appearing twice**; we score one representative per mirror pair, and the
front/back flip is left to the user — per-joint dropdowns, or click the joint
in the 3D view. Nine bits is also the whole sign table now: trunk + 8 limb
joints, no followers (the head has no sign, §1).

**Why 256 candidates is cheap.** A sign only ever multiplies its own bone's
`dz`, and a joint's depth is the sum of signed `dz` along the walk from the
pelvis — so depth is *linear* in the sign vector. Per frame the geometry
factors into one matrix `M` with `z = M @ s`, and the whole search is a matmul
(~30 ms/clip) instead of 512 lifts (~11 s).

The trunk gets the same treatment as a bone: shoulder width (0.85 torso) and
hip width (0.72) are known, measured foreshortened on screen, so

```
dz_pair = sqrt(W² − d2d²) / 2
```

pushes one shoulder forward and the other back. Pinning the trunk flat
(`z = 0`) was discarding ~0.67 torso of shoulder depth on the test lift.

---

## 4. Picking the sign — balance

**Formula** (minimised over candidates)

```
cost = mean_frames |COM_z − feet_z| / torso  +  0.001 · Σ distance_violations
```

`COM` = mean of all solved joints, `feet` = mean of the ankles.

**Intuition** — a standing athlete's centre of mass is over their feet. The
*x* part of that offset is identical for all candidates (it comes from the 2D
pose), so **all the discriminating power sits in depth** — exactly the unknown.
A sign pattern that hangs the body a metre in front of its own feet is one
nobody could hold.

```
   side view, looking along the bar

        COM                     COM
         *                             *
        /|\                     /|\      ←  falls forward
       / | \                   / | \        (rejected)
      ---+---                ---+-------
         ^feet                  ^feet
      balanced ✓             off in z ✗
```

The second term (`_NONADJ_RANGE`) checks that limbs sharing no bone stay a
plausible distance apart — two knees cannot occupy the same point. It is
weighted near zero on purpose: as a *maximum* test it ranks answers backwards,
because giving every limb the same sign packs the body into one plane and
shortens every cross-body distance. It survives only as a tie-break.

Frames are pre-filtered to the *quietest* ones (least motion), where the
balance assumption actually holds.

---

## 4b. Ruling signs out — the start position

Balance is an aggregate: it answers *does this whole body look plausible*. It
cannot answer *does that knee bend the way a knee bends*, and on a lift with a
floor start the second question has an answer before any reconstruction runs.

At the set position of a snatch or a clean the athlete is still, hands on a bar
on the floor, hips and knees flexed, arms straight. Every candidate sign vector
implies a hip, knee, shoulder and elbow angle there, and most of the 256 imply
one no body holds:

```
      angle at joint b between (a−b) and (c−b), both sides

        hip  (sho–hip–kne)      15…85°     torso is over the bar
        knee (hip–kne–ank)      45…145°    bent, not locked, not folded
        elbow(sho–elb–wri)     140…180°    arms hang straight from the bar
        shoulder(hip–sho–elb)   10…115°    weak — rules out arm-behind-torso
```

Each angle is a function of exactly one sign bit or one *product* of two, which
is why these four and no others: a joint one bone from the trunk (hip, shoulder)
pins that bone's sign outright, since the trunk is already fixed by the rigid
fit; a joint between two bones (knee, elbow) can only see the product, so it
pins the second given the first. Two tests per limb chain, four chains, eight
bits.

Measured, only the **hip and elbow** currently rule anything out — both knee
options and both shoulder options land inside their ranges on both fixtures. The
knee's bound is loose on purpose: the clean-and-jerk's two options are 71° and
127° against a 108° projection from a near-side-on camera, so a bound tight
enough to bite would rule out the reading the image itself supports.

cost = Σ (degrees outside the range)² / 100, averaged over the setup frames.
Everything within 0.25 of the minimum survives; the balance cost of §4 then
ranks the survivors. **It eliminates, it does not choose** — a fact about one
joint filters, a guess about the whole body only ranks.

Two properties make this safe to apply as a hard filter:

* **Mirror-invariant.** Every test is an angle between two vectors, and
  negating all signs reflects the pose without changing any angle. So the gate
  never claims to know which way the athlete faces — the §3 gauge freedom
  survives it untouched.
* **Self-disqualifying.** The setup frames are found from the 2D pose alone:
  wrists within 0.8 torso of the ankles (bar on the floor) and least motion
  (the set, not the lift-off). A clip trimmed to start after the pull has no
  such frame and gets no gate. Measured: 0.32 torso on the clean-and-jerk
  fixture and 0.34 on the snatch, against 1.20 and 1.66 on the two standing
  lateral raises — which is also why the gate is restricted by lift type, since
  scoring a standing athlete against a setup's ranges costs 57.

Measured on the fixtures (per-clip length estimates, `lift` set):

| clip | survivors | winner changes? | runner-up margin | mirror residual |
|---|---|---|---|---|
| athlete-b clean & jerk | 32 / 256 | no | 0.028 → 0.028 | 0.423 → 0.423 |
| athlete-a snatch | 8 / 256 | **yes** | 0.003 → 0.041 | 0.854 → **0.467** |

On the snatch the old winner put the hips at 90°/104° and the knees at 43°/44°
in a set position — the gate rejects it. The mirror residual is the check worth
weighting: it is not in the gate and not in the balance cost
(`_SYMMETRY_WEIGHT = 0`), and it nearly halves. The balance term goes the other
way, 0.12 → 0.47, which is the honest cost of the change and is consistent with
a sign that switches part-way through that clip — see TODO item 5.

---

## 5. The plate-anchor variant

When plates are detected, depth is seeded from the equipment instead of guessed:

```
   1. ellipse → s (mm/px) and bar axis in 3D          (§2)
   2. wrist is on the bar → wrist z = bar's z beneath it
   3. BFS outward from the wrists, dz from the bone prior  (§1)
```

This is the only path that produces real millimetres. It needs both a plate
ellipse and a visible wrist; otherwise it falls back to anchoring the pelvis at
`z = 0`.

---

## 6. The tied-sign failure (fixed)

Ankles used to inherit the knee's sign, and wrists the elbow's. For a
**straight** limb that is correct. For a **flexed** one it is backwards:

```
   squat, seen from the side

     hip o
          \           thigh goes FORWARD  (+z)
           \
        knee o
            /         shank goes BACKWARD (−z)
           /
      ankle o

   Tying them forces both the same way, so the foot is
   flung out to knee_z + shank_z instead of back under the hip.
```

Measured over the example clip (every sign assignment, every frame, keeping the
smallest separation each scheme can reach): median floor **0.50 torso** with the
tied rule versus **0.15** with the ankle free. A feet-together squat was
therefore *geometrically unreachable*, no matter what the balance score said —
the winner put the feet **1.86 torso** apart, about a metre.

Fixed by freeing the four distal bits (2⁹ = 512 candidates, ~30 ms via the
matmul in §3) plus an explicit foot-separation term in the cost (§4). Same
frame now reconstructs with the feet **0.33 torso** apart.

**Second defect, same section.** The bone priors were scaled by the *per-frame*
projected torso, which runs 141–251 px over this clip (1.78×) — so every bone
shrank by up to a third exactly when the athlete bent over, while `x`/`y` stayed
in real pixels. Now one clip-level scale (p95 of the projection, since a
projection is never longer than what it projects). See §2.

The lesson worth keeping: a cost function can only rank the reconstructions its
parameterisation can *express*. Both defects scored well and were found by
checking the output against anatomy, not against the objective.

See `report.pdf` §A.7 and Fig. 5.
