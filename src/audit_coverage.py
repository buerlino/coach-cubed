"""How many real attempts did finalize.py actually keep, out of how many the
referee lights alone prove happened? A low-confidence camera-layout match
(see analyze.py's warning) can mean two different things: a template that
doesn't fit this broadcast's graphic, or a graphic that fits fine but keeps
getting cut away from (other camera, picture-in-picture, big-screen replay) -
this tells them apart and quantifies the damage.
usage: audit_coverage.py SIGNALS.npz
"""
import sys, numpy as np
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from finalize import clock_signal
from final import build, light_episodes
from detect import detect

FPS = 10

def audit(npz_path):
    z = np.load(npz_path)
    valid = z['valid']
    d = clock_signal(z['units'], valid)
    sig = np.stack([z['P'], z['U']], 1)
    lt = z['lights'].astype(int).copy(); lt[~valid] = 0

    cands = [c for c in detect(sig, d) if c['ok']]
    matched = build(sig, d, lt)
    kept = []
    for c in matched:
        a, b = int((c['start']-1)*FPS), int((c['lights_t']+0.5)*FPS)
        frac = valid[max(0, a):b].mean() if b > a else 0
        if frac > 0.97: kept.append(c)

    eps = light_episodes(lt)
    unmatched = [L for L in eps if not any(
        c['anchor'] < L['t'] and L['t']-c['anchor'] < 25 for c in cands)]

    print(f"board visible {valid.mean()*100:.0f}% of the video")
    print(f"{len(eps)} referee-light decisions (the true attempt count, modulo "
          f"any light flicker split into two close episodes)")
    print(f"{len(cands)} clock-freeze candidates found")
    print(f"{len(matched)} candidates matched to a light decision")
    print(f"{len(matched)-len(kept)} of those dropped by the >97% visibility filter")
    print(f"{len(unmatched)} light decisions with NO clock-freeze candidate at all "
          f"(the board was probably off-screen, cut to another camera or a "
          f"picture-in-picture layout, right when this attempt started)")
    print(f"=> {len(kept)}/{len(eps)} real attempts made it into clips.json "
          f"({len(kept)/len(eps)*100:.0f}% recall)" if eps else "=> no light decisions found")
    return kept, eps, unmatched

if __name__ == '__main__':
    audit(sys.argv[1])
