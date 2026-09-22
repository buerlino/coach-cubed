"""Cut the detected clips out of the source video with ffmpeg."""
import os, subprocess
from concurrent.futures import ThreadPoolExecutor

def _cut_one(job):
    video, start, dur, outpath = job
    subprocess.run(
        ['ffmpeg', '-v', 'error', '-y', '-ss', f'{start:.2f}', '-i', video, '-t', f'{dur:.2f}',
         '-an', '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-pix_fmt', 'yuv420p', outpath],
        check=True)
    return outpath

def cut_clips(video, clips, outdir, session, workers=8):
    os.makedirs(outdir, exist_ok=True)
    clips = sorted(clips, key=lambda c: c['start'])
    jobs = []
    for i, c in enumerate(clips, 1):
        t = int(c['start']); hh, mm, ss = t // 3600, (t % 3600) // 60, t % 60
        name = f"{session}_{i:02d}_{hh}h{mm:02d}m{ss:02d}s_{c['result']}.mp4"
        jobs.append((video, c['start'], c['end'] - c['start'], os.path.join(outdir, name)))
    with ThreadPoolExecutor(max_workers=workers) as ex:
        paths = list(ex.map(_cut_one, jobs))
    return paths
