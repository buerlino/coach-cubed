"""Optional QA aid: save an 8-frame contact-sheet PNG per clip (or per group of
clips) so you can eyeball the results without opening every video file."""
import os, subprocess, numpy as np, cv2

def build_sheets(video, clips, outdir, per_sheet=7):
    os.makedirs(outdir, exist_ok=True)
    clips = sorted(clips, key=lambda c: c['start'])
    rows = []
    for n, c in enumerate(clips, 1):
        tiles = []
        for t in np.linspace(c['start'], c['end'], 8):
            raw = subprocess.run(
                ['ffmpeg', '-v', 'error', '-ss', f'{t:.2f}', '-i', video, '-frames:v', '1',
                 '-vf', 'scale=300:169', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'],
                capture_output=True).stdout
            f = (np.frombuffer(raw, np.uint8).reshape(169, 300, 3).copy()
                 if len(raw) == 300*169*3 else np.zeros((169, 300, 3), np.uint8))
            cv2.putText(f, f'{t:.1f}', (4, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 255), 1)
            tiles.append(f)
        row = np.hstack(tiles)
        label = f"#{n} {c['result']} len={c['end']-c['start']:.1f}s @ {c['start']:.0f}s"
        cv2.putText(row, label, (4, 163), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 0), 1)
        rows.append(row)
    paths = []
    for k in range(0, len(rows), per_sheet):
        p = os.path.join(outdir, f'sheet_{k//per_sheet:03d}.png')
        cv2.imwrite(p, np.vstack(rows[k:k+per_sheet]))
        paths.append(p)
    return paths
