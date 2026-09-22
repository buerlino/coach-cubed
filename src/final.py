import sys, json, numpy as np
sys.path.insert(0, __file__.rsplit('/',1)[0])
from detect import detect
fps=10
def light_episodes(lt):
    dec=lt.sum(1)>=2; idx=np.flatnonzero(dec); segs=[]
    if not len(idx): return segs
    s=p=idx[0]
    for i in idx[1:]:
        if i-p>30: segs.append((s,p)); s=i
        p=i
    segs.append((s,p))
    return [dict(t=s/fps, made=bool(np.median(lt[s:e+1,0])>=2)) for s,e in segs]
def build(sig, clockd, lt, max_after_onset=15.0):
    cands=[c for c in detect(sig,clockd) if c['ok']]
    out=[]; used=set()
    for L in light_episodes(lt):
        prev=[c for c in cands if c['anchor']<L['t'] and L['t']-c['anchor']<25]
        if not prev: continue
        c=prev[-1]
        if c['anchor'] in used: continue
        used.add(c['anchor'])
        # detect()'s own end already stops at the lift's natural settle point; the onset
        # and lights_t caps here are just safety nets against a runaway motion merge.
        end=min(c['end'], c['onset']+max_after_onset, L['t'])
        start=c['start']
        if end-start<3.5: end=start+3.5
        out.append(dict(start=round(start,2), end=round(end,2), anchor=c['anchor'], lights_t=L['t'], result='made' if L['made'] else 'miss'))
    return out
if __name__=='__main__':
    sig=np.load(sys.argv[1]); d=np.load(sys.argv[2]); lt=np.load(sys.argv[3])
    o=build(sig,d,lt); json.dump(o,open(sys.argv[4],'w'))
    for x in o: print(x, f"len={x['end']-x['start']:.1f}")
    print(len(o),'clips')
