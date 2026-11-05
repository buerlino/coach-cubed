# SPDX-License-Identifier: AGPL-3.0-or-later
"""scripts/batch_extract_tracks.py: the manifest entry's "diagnostics" field.

process_clip runs with the server calls (start_job, wait_for_result) faked: no
ViTPose, no network. The fake result is a made-up payload shaped like the
server's ({"keypoints", "meta"}); no test here reads its values for anything
but the manifest entry's bookkeeping fields.
"""
from pathlib import Path
import contextlib
import io
import runpy
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
# run_name is not '__main__', so main() does not run.
# The script imports requests at the top; process_clip is run with the server calls
# faked, so a stub stands in and the tests need no HTTP client installed.
with mock.patch.dict(sys.modules, {'requests': mock.Mock()}):
    bet = runpy.run_path(str(ROOT / 'scripts' / 'batch_extract_tracks.py'), run_name='batch_extract_tracks')
process_clip = bet['process_clip']
FAKE_RESULT = {'keypoints': [], 'meta': {'frame_count': 3, 'frames_processed': 3, 'tracks': {'kept': 0}}}


def run(tmp, manifest, stance='snatch', **kw):
    clip = Path(tmp) / 'src' / 'lift.mp4'
    clip.parent.mkdir(exist_ok=True)
    clip.write_bytes(b'x')
    out = Path(tmp) / 'out'
    g = process_clip.__globals__
    with mock.patch.dict(g, {'start_job': lambda *a, **k: None,
                             'wait_for_result': lambda *a, **k: FAKE_RESULT}), \
            contextlib.redirect_stdout(io.StringIO()):
        process_clip('http://x', clip, stance, 'l', 1, out, manifest, **kw)
    return manifest[f'{stance}/lift']


class Diagnostics(unittest.TestCase):
    def test_a_new_entry_gets_the_stance_as_its_diagnostics_set(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(run(tmp, {}, 'snatch')['diagnostics'], 'snatch')
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(run(tmp, {}, 'clean-and-jerk')['diagnostics'], 'clean-and-jerk')

    def test_the_option_sets_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            entry = run(tmp, {}, 'clean', diagnostics='clean-and-jerk')
            self.assertEqual(entry['diagnostics'], 'clean-and-jerk')
            self.assertEqual(entry['stance'], 'clean')

    def test_a_re_extract_keeps_a_hand_set_value(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest = {'example/lift': {'diagnostics': 'snatch', 'labels': ['a:good'], 'notes': 'n'}}
            entry = run(tmp, manifest, 'example')
            self.assertEqual(entry['diagnostics'], 'snatch')
            self.assertEqual((entry['labels'], entry['notes']), (['a:good'], 'n'))

    def test_the_option_overrides_a_hand_set_value_on_a_re_extract(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest = {'example/lift': {'diagnostics': 'snatch'}}
            self.assertEqual(run(tmp, manifest, 'example', diagnostics='clean-and-jerk')['diagnostics'],
                             'clean-and-jerk')

    def test_the_command_line_passes_the_option_through(self):
        calls = []
        g = bet['main'].__globals__
        with tempfile.TemporaryDirectory() as tmp:
            clip = Path(tmp) / 'lift.mp4'
            clip.write_bytes(b'x')
            argv = ['b', '--stance', 'clean', '--diagnostics', 'clean-and-jerk',
                    '--out-dir', str(Path(tmp) / 'out'), str(clip)]
            fake_requests = mock.Mock()
            with mock.patch.dict(g, {'process_clip': lambda *a, **k: calls.append((a, k)),
                                     'requests': fake_requests}), \
                    mock.patch.object(sys, 'argv', argv), contextlib.redirect_stdout(io.StringIO()):
                bet['main']()
            self.assertEqual(calls[0][1].get('diagnostics'), 'clean-and-jerk')
            calls.clear()
            with mock.patch.dict(g, {'process_clip': lambda *a, **k: calls.append((a, k)),
                                     'requests': fake_requests}), \
                    mock.patch.object(sys, 'argv', argv[:3] + argv[5:]), contextlib.redirect_stdout(io.StringIO()):
                bet['main']()
            self.assertIsNone(calls[0][1].get('diagnostics'))


if __name__ == '__main__': unittest.main()
