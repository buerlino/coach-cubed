import numpy as np
fps=10
def clock_events(d):
    thr=max(20, np.median(d)*3)
    on=d>thr
    return [ (i/fps-0.5) for i in range(1,len(d)) if on[i] and not on[i-1] ]
def runs(ev, min_len=6):
    out=[]; cur=[ev[0]]
    for a,b in zip(ev,ev[1:]):
        if 0.3<=b-a<=2.7: cur.append(b)
        else:
            if len(cur)>=min_len: out.append(cur)
            cur=[b]
    if len(cur)>=min_len: out.append(cur)
    return out
if __name__=='__main__':
    import sys
    d=np.load(sys.argv[1]); ev=clock_events(d); rs=runs(ev)
    for r in rs: print(f'run {r[0]:7.1f} -> {r[-1]:7.1f}  ({len(r)} ticks)')
    print(len(rs),'runs')
