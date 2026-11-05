# SPDX-License-Identifier: AGPL-3.0-or-later
"""scripts/sync_clipper_fixtures.py: clipper's clip names, 2 digits or 3."""
from pathlib import Path
import runpy
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
# run_name is not '__main__', so main() does not run.
sync = runpy.run_path(str(ROOT / 'scripts' / 'sync_clipper_fixtures.py'), run_name='sync_clipper_fixtures')
CLIP_NAME_RE = sync['CLIP_NAME_RE']


def clipper_name(session, i, t, result):
    # clipper's own format, weightlifting-clipper src/cut.py:19 (cut_clips):
    #   t = int(c['start']); hh, mm, ss = t // 3600, (t % 3600) // 60, t % 60
    #   name = f"{session}_{i:02d}_{hh}h{mm:02d}m{ss:02d}s_{c['result']}.mp4"
    hh, mm, ss = t // 3600, (t % 3600) // 60, t % 60
    return f"{session}_{i:02d}_{hh}h{mm:02d}m{ss:02d}s_{result}.mp4"


class ClipNames(unittest.TestCase):
    def test_matches_clippers_names_for_two_and_three_digit_attempts(self):
        session = '18-2025-australian-senior-junior-championships-session-8-and-9-x'
        for i in (1, 99, 100, 123):
            for result in ('made', 'miss', 'unknown'):
                name = clipper_name(session, i, 7287, result)
                m = CLIP_NAME_RE.match(name)
                self.assertIsNotNone(m, name)
                self.assertEqual((m['session'], int(m['idx']), m['result']), (session, i, result), name)
                self.assertEqual((m['hh'], m['mm'], m['ss']), ('2', '01', '27'), name)

    def test_rejects_a_name_without_a_result(self):
        self.assertIsNone(CLIP_NAME_RE.match('Session14_01_0h18m07s.mp4'))
        self.assertIsNone(CLIP_NAME_RE.match('Session14_100_0h18m07s_.mp4'))
        self.assertIsNone(CLIP_NAME_RE.match('Session14_100_0h18m07s_maybe.mp4'))

    def test_a_session_name_with_digits_keeps_its_attempt_number(self):
        m = CLIP_NAME_RE.match(clipper_name('Session_12_3', 100, 5, 'made'))
        self.assertEqual((m['session'], m['idx']), ('Session_12_3', '100'))


class Discovery(unittest.TestCase):
    def test_attempts_come_in_numeric_order_and_stems_stay_distinct(self):
        with tempfile.TemporaryDirectory() as tmp:
            clips = Path(tmp) / 'video' / 'clips'
            clips.mkdir(parents=True)
            names = [clipper_name('S', i, i * 30, 'made') for i in (1, 2, 99, 100, 101, 123)]
            for name in reversed(names):
                (clips / name).write_bytes(b'')
            found = sync['discover_clips'](Path(tmp))
            self.assertEqual([p.name for p in found], names)
            self.assertEqual(len({p.stem for p in found}), len(names))


if __name__ == '__main__': unittest.main()
