"""Turn one video's raw analysis (signals.npz from analyze.py) into a list of
per-attempt clips (start/end/result), written to a JSON file.
usage: finalize.py SIGNALS.npz OUT.json
"""
import sys, json, os, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from final import build

FPS = 10

def clock_signal(units, valid, lag=5, K=3):
    """How much the clock's units digit changed, frame to frame. Used to find
    the moment the scoreboard clock freezes (a lifter has taken the bar)."""
    M = units.astype(np.float32) / 255.0
    Ms = np.array([M[max(0, i-K//2):i+K//2+1].mean(0) for i in range(len(M))])
    d = np.zeros(len(M)); d[lag:] = np.abs(Ms[lag:] - Ms[:-lag]).sum((1, 2))
    # only trust frames whose whole comparison window had the board in view
    ok = np.convolve(valid.astype(float), np.ones(lag+K)/(lag+K), 'same') > 0.999
    d[~ok] = 0
    return d

def run(npz_path, out_json):
    z = np.load(npz_path)
    valid = z['valid']; t0 = float(z['t0'])
    d = clock_signal(z['units'], valid)
    sig = np.stack([z['P'], z['U']], 1)
    lt = z['lights'].astype(int).copy(); lt[~valid] = 0
    clips = build(sig, d, lt)
    keep = []
    for c in clips:
        a, b = int((c['start']-1)*FPS), int((c['lights_t']+0.5)*FPS)
        frac = valid[max(0, a):b].mean() if b > a else 0
        if frac > 0.97:
            keep.append(c)
    for c in keep:
        for k in ('start', 'end', 'anchor', 'lights_t'):
            c[k] = round(float(c[k]) + t0, 2)
    json.dump(keep, open(out_json, 'w'), indent=1)
    return keep

if __name__ == '__main__':
    keep = run(sys.argv[1], sys.argv[2])
    for c in keep:
        print(f"{c['start']:8.1f} {c['end']:8.1f} len={c['end']-c['start']:.1f} {c['result']}")
    print(len(keep), 'clips')
