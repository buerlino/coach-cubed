"""Launch routes: python -m unittest discover -s tests -p 'test_*.py'."""
import contextlib
import functools
import http.client
import io
import json
from pathlib import Path
import runpy
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
ROOT = Path(__file__).resolve().parents[1]
LAUNCHERS = ROOT / 'launchers'
sys.path.insert(0, str(LAUNCHERS))
import run_local

class Server:
    def __init__(self, address, handler): self.server_port = address[1]
    def serve_forever(self): pass
    def server_close(self): pass

class Launchers(unittest.TestCase):
    def launch(self, workspace=None):
        output = io.StringIO()
        with patch.object(sys, 'argv', ['run_local.py', '--no-browser']), patch.object(run_local.http.server, 'ThreadingHTTPServer', Server), contextlib.redirect_stdout(output):
            run_local.main(workspace=workspace)
        return output.getvalue()

    def test_default_opens_the_lift_page_at_the_root(self):
        self.assertIn('Open http://127.0.0.1:8785/\n', self.launch())

    def test_workspaces_open_distinct_pages(self):
        self.assertIn('Open http://127.0.0.1:8785/\n', self.launch('original'))
        self.assertIn('Open http://127.0.0.1:8784/squat/\n', self.launch('anatomy'))

    def test_legacy_and_named_entry_points(self):
        for entry, kwargs in [('run_squat.py', {}), ('run_original.py', {'workspace': 'original'}), ('run_anatomy.py', {'workspace': 'anatomy'})]:
            with patch.object(run_local, 'main') as main:
                runpy.run_path(str(LAUNCHERS / entry), run_name='__main__')
                main.assert_called_once_with(**kwargs)

class PreviewRoutes(unittest.TestCase):
    """The page's asset paths are relative, so it only works served at '/'."""
    def setUp(self):
        handler = functools.partial(run_local.LocalHandler, directory=str(run_local.SRC))
        self.server = run_local.http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def get(self, path):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=10)
        self.addCleanup(conn.close)
        conn.request('GET', path)
        response = conn.getresponse()
        return response, response.read()

    def test_old_original_links_redirect_relatively_to_the_root(self):
        for path, location in [('/original/', '../'), ('/original', './')]:
            response, _ = self.get(path)
            self.assertEqual((response.status, response.getheader('Location')), (302, location), path)

    def test_a_global_example_finds_its_clip_under_local(self):
        # Third-party clips aren't committed (tests/fixtures/README.md, "Videos").
        with tempfile.TemporaryDirectory() as tmp:
            fixtures = Path(tmp) / 'tests/fixtures'
            (fixtures / 'global/example').mkdir(parents=True)
            (fixtures / 'local/example').mkdir(parents=True)
            (fixtures / 'global/manifest.json').write_text(json.dumps({'example/clip': {'source_file': 'clip.mp4', 'model_size': 'l'}}))
            (fixtures / 'global/example/clip.track.json').write_text('{}')
            (fixtures / 'local/example/clip.mp4').write_bytes(b'video')
            with patch.object(run_local, 'ROOT', Path(tmp)):
                response, body = self.get('/api/examples')
                self.assertEqual([e['id'] for e in json.loads(body)], ['global/example/clip'])
                response, body = self.get('/api/examples/global/example/clip/video')
                self.assertEqual((response.status, body), (200, b'video'))

    def test_root_serves_the_page_and_its_relative_assets(self):
        response, body = self.get('/')
        self.assertEqual(response.status, 200)
        page = body.decode()
        for ref in ['./diagnostics.js', './logo.png', './pose/local-mode.mjs', './vendor/three.module.js']:
            self.assertIn(ref, page)
            asset, _ = self.get(ref[1:])
            self.assertEqual(asset.status, 200, ref)

if __name__ == '__main__': unittest.main()
