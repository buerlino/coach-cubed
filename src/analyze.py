"""Stream one session video once and extract per-frame signals (10 fps):
   board location (tracked), validity (platform camera visible), platform/upper
   motion, clock units-digit mask, referee-light counts.

usage: analyze.py VIDEO OUT.npz --templates TEMPLATES_DIR [--start T0] [--duration D]
"""
import sys, os, argparse, subprocess, numpy as np, cv2
cv2.setNumThreads(2)
FPS, W, H = 10, 960, 540

FRONT_LB = [((23,50,58,78),(60,50,95,78)), ((112,50,147,78),(149,50,183,78)), ((200,50,235,78),(237,50,270,78))]
ANG_LB = [((40,88,74,122),(76,88,108,122)), ((121,100,155,134),(157,100,187,134)), ((199,112,233,146),(235,112,267,146))]

def _load(p, flag=cv2.IMREAD_GRAYSCALE):
    img = cv2.imread(p, flag)
    if img is None:
        raise FileNotFoundError(f'template not found: {p}')
    return img

def build_models(templates_dir):
    return {
        'frontal': dict(tpl=_load(os.path.join(templates_dir, 'front_tpl.png')),
                        mask=_load(os.path.join(templates_dir, 'front_mask.png')),
                        scales=[round(0.9+0.025*i, 3) for i in range(15)], coarse=[0.9, 1.0, 1.1, 1.2], thr=0.55,
                        units=(130,92,165,142), lights=FRONT_LB, P=(-1250,-20,-90,640), U=(-90,300)),
        'angled': dict(tpl=_load(os.path.join(templates_dir, 'board_tpl.png')), mask=None,
                       scales=[1.0], coarse=[1.0], thr=0.6,
                       units=(135,140,195,215), lights=ANG_LB, P=(-1060,-20,10,898), U=(10,330)),
    }

_cache = {}
def scaled(models, name, s, f):
    k = (name, s, f)
    if k not in _cache:
        m = models[name]; z = s * f
        t = cv2.resize(m['tpl'], None, fx=z, fy=z, interpolation=cv2.INTER_AREA)
        mk = None if m['mask'] is None else cv2.resize(m['mask'], None, fx=z, fy=z, interpolation=cv2.INTER_NEAREST)
        _cache[k] = (t, mk)
    return _cache[k]

def match(models, img, name, s, f):
    t, mk = scaled(models, name, s, f)
    if img.shape[0] < t.shape[0] or img.shape[1] < t.shape[1]: return -1, (0, 0)
    r = cv2.matchTemplate(img, t, cv2.TM_CCOEFF_NORMED, mask=mk) if mk is not None else cv2.matchTemplate(img, t, cv2.TM_CCOEFF_NORMED)
    r = np.nan_to_num(r, nan=-1, posinf=-1, neginf=-1); _, mx, _, loc = cv2.minMaxLoc(r); return mx, loc

def find_board(models, g960, g480, name, last):
    m = models[name]; sc = m['scales']
    if last is not None:
        x, y, s = last; best = (-1, None)
        i = min(range(len(sc)), key=lambda k: abs(sc[k] - s))
        for k in {max(0, i-1), i, min(len(sc)-1, i+1)}:
            t, _ = scaled(models, name, sc[k], 0.5); pad = 24
            x0, y0 = max(0, x-pad), max(0, y-pad)
            sub = g960[y0:y+t.shape[0]+pad, x0:x+t.shape[1]+pad]
            mx, loc = match(models, sub, name, sc[k], 0.5)
            if mx > best[0]: best = (mx, (x0+loc[0], y0+loc[1], sc[k]))
        if best[0] >= m['thr']: return best[1]
    best = (-1, None)
    for s in m['coarse']:
        mx, loc = match(models, g480, name, s, 0.25)
        if mx > best[0]: best = (mx, (loc[0]*2, loc[1]*2, s))
    if best[0] < m['thr'] - 0.15: return None
    x, y, s0 = best[1]; ref = (-1, None)
    i = min(range(len(sc)), key=lambda k: abs(sc[k] - s0))
    for k in range(max(0, i-2), min(len(sc), i+3)):
        t, _ = scaled(models, name, sc[k], 0.5); pad = 20
        x0, y0 = max(0, x-pad), max(0, y-pad)
        sub = g960[y0:y+t.shape[0]+pad, x0:x+t.shape[1]+pad]
        mx, loc = match(models, sub, name, sc[k], 0.5)
        if mx > ref[0]: ref = (mx, (x0+loc[0], y0+loc[1], sc[k]))
    return ref[1] if ref[0] >= m['thr'] else None

def choose_model(models, video, t0, dur):
    res = {name: 0 for name in models}; n = 0
    for k in range(1, 13):
        t = t0 + dur * k / 13
        raw = subprocess.run(['ffmpeg','-v','error','-ss',str(t),'-i',video,'-frames:v','1','-vf',f'scale={W}:{H}','-f','rawvideo','-pix_fmt','bgr24','-'], capture_output=True).stdout
        if len(raw) != W*H*3: continue
        g = cv2.cvtColor(np.frombuffer(raw, np.uint8).reshape(H, W, 3), cv2.COLOR_BGR2GRAY); g4 = cv2.resize(g, (480, 270), interpolation=cv2.INTER_AREA)
        n += 1
        for name in models:
            if find_board(models, g, g4, name, None) is not None: res[name] += 1
    return max(res, key=res.get), res, n

def roi(t, loc, s, sc=0.5):
    x, y = loc
    return int(round(x + t[0]*s*sc)), int(round(y + t[1]*s*sc)), int(round(x + t[2]*s*sc)), int(round(y + t[3]*s*sc))

def analyze(video, out, t0=0.0, dur=None, templates_dir=None):
    models = build_models(templates_dir)
    if dur is None:
        dur = float(subprocess.run(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',video], capture_output=True, text=True).stdout)
    name, votes, n = choose_model(models, video, t0, dur)
    print(f'  camera layout: {name}  (votes {votes} / {n} sampled frames)', flush=True)
    if votes[name] < n * 0.3:
        print(f'  WARNING: low confidence match ({votes[name]}/{n}). This video\'s scoreboard '
              f'graphic may not match the bundled templates in {templates_dir}.', flush=True)
    m = models[name]
    cmd = ['ffmpeg','-v','error','-threads','3','-ss',str(t0),'-t',str(dur),'-i',video,'-vf',f'fps={FPS},scale={W}:{H}','-f','rawvideo','-pix_fmt','bgr24','-']
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=W*H*3*4)
    N = int(dur * FPS) + 5
    valid = np.zeros(N, bool); Pm = np.zeros(N, np.float32); Um = np.zeros(N, np.float32)
    units = np.zeros((N, 25, 30), np.uint8); lights = np.zeros((N, 2), np.uint8); loc_arr = np.zeros((N, 3), np.float32)
    last = None; prev = None; prev_loc = None; i = 0
    while True:
        raw = p.stdout.read(W*H*3)
        if len(raw) < W*H*3 or i >= N: break
        fr = np.frombuffer(raw, np.uint8).reshape(H, W, 3)
        g960 = cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY); g480 = cv2.resize(g960, (480, 270), interpolation=cv2.INTER_AREA)
        if i % 5 == 0:
            last = find_board(models, g960, g480, name, last)
        if last is None: prev = None; i += 1; continue
        x, y, s = last; valid[i] = True; loc_arr[i] = (x, y, s)
        x0, y0, x1, y1 = roi(m['units'], (x, y), s)
        r = fr[y0:y1, x0:x1].astype(np.int16)
        if r.size:
            b, g, rr = r[:,:,0], r[:,:,1], r[:,:,2]
            mk = ((rr > 130) & (rr > 1.7*g) & (rr > 1.7*b)).astype(np.float32)
            units[i] = (cv2.resize(mk, (30, 25), interpolation=cv2.INTER_AREA) * 255).astype(np.uint8)
        w = rd = 0
        for (l, rt) in m['lights']:
            lx0, ly0, lx1, ly1 = roi(l, (x, y), s); rx0, ry0, rx1, ry1 = roi(rt, (x, y), s)
            R = fr[ry0:ry1, rx0:rx1]; L = fr[ly0:ly1, lx0:lx1]
            if R.size and (R.min(2) > 190).mean() > 0.10: w += 1
            if L.size and ((L[:,:,2] > 215) & (L[:,:,1] > 110)).mean() > 0.10: rd += 1
        lights[i] = (w, rd)
        bx, by = x*2, y*2
        px0, px1, py0, py1 = m['P']; ux0, ux1 = m['U']
        X0, X1 = max(0, (bx+px0)//4), max(1, (bx+px1)//4)
        Y0, Y1 = max(0, (by+py0)//4), min(270, (by+py1)//4); UY1 = min(270, (by+ux1)//4)
        if prev is not None and prev_loc is not None and abs(prev_loc[0]-x) <= 3 and abs(prev_loc[1]-y) <= 3:
            dframe = np.abs(g480.astype(np.float32) - prev)
            Pm[i] = dframe[Y0:Y1, X0:X1].mean(); Um[i] = dframe[Y0:UY1, X0:X1].mean()
        prev = g480.astype(np.float32); prev_loc = (x, y)
        i += 1
        if i % 6000 == 0: print(f'    {i/FPS/60:.0f} min processed', flush=True)
    p.stdout.close(); p.wait()
    np.savez_compressed(out, model=name, t0=t0, n=i, valid=valid[:i], P=Pm[:i], U=Um[:i], units=units[:i], lights=lights[:i], loc=loc_arr[:i])
    print(f'  done: {i} frames, board visible {valid[:i].mean()*100:.0f}% of the time', flush=True)

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('video'); ap.add_argument('out')
    ap.add_argument('--templates', required=True)
    ap.add_argument('--start', type=float, default=0.0)
    ap.add_argument('--duration', type=float, default=None)
    a = ap.parse_args()
    analyze(a.video, a.out, a.start, a.duration, a.templates)

if __name__ == '__main__':
    main()
