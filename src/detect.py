import sys, json, numpy as np
sys.path.insert(0, __file__.rsplit('/',1)[0])
from anchors import clock_events, runs
fps=10
def smooth(x,n=5): return np.convolve(x,np.ones(n)/n,'same')
def merged_segments(active, gap_tol_frames):
    idx=np.flatnonzero(active)
    if len(idx)==0: return []
    segs=[]; s=p=idx[0]
    for k in idx[1:]:
        if k-p>gap_tol_frames: segs.append((s,p)); s=k
        p=k
    segs.append((s,p)); return segs
def detect(sig, clockd, floor=2.2, gap_tol=1.5, search_window=16.0):
    """One lift = clock-freeze onset, followed by one merged run of platform/upper motion
    that tolerates short pauses (e.g. the rack pause between a clean and its jerk)."""
    P=smooth(sig[:,0]); U=smooth(sig[:,1])
    A=[r[-1] for r in runs(clock_events(clockd))]
    res=[]
    for a in A:
        i0,i1=int(max(0,(a-3)*fps)),int((a+1.5)*fps)
        on=np.flatnonzero(P[i0:i1]>3.0)
        if len(on)==0: res.append(dict(anchor=a,ok=False,why='no onset')); continue
        onset=(i0+on[0])/fps
        j0=int(onset*fps); j1=min(len(P), int((onset+search_window)*fps))
        active=np.maximum(P[j0:j1],U[j0:j1])>floor
        segs=merged_segments(active, int(gap_tol*fps))
        peakU=U[int((a-1.5)*fps):int((a+3.5)*fps)].max()
        if not segs or peakU<5: res.append(dict(anchor=a,ok=False,why=f'peakU={peakU:.1f}')); continue
        first=segs[0]                          # the run starting at the lift's onset
        end=(j0+first[1])/fps + 0.4
        start=onset-1.0; end=min(end, onset+search_window-0.5)
        if end-start<3.5: end=start+3.5
        res.append(dict(anchor=a,onset=onset,start=start,end=end,nsegs=len(segs),peakU=float(peakU),ok=True))
    return res
if __name__=='__main__':
    sig=np.load(sys.argv[1]); d=np.load(sys.argv[2]); r=detect(sig,d)
    for x in r: print({k:(round(v,1) if isinstance(v,float) else v) for k,v in x.items()})
    json.dump(r,open(sys.argv[3],'w'))
