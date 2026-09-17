"""Launch routes: python -m unittest discover -s tests -p 'test_*.py'."""
import contextlib
import io
from pathlib import Path
import runpy
import sys
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
    def launch(self, default, workspace=None):
        output = io.StringIO()
        with patch.object(sys, 'argv', ['run_local.py', '--no-browser']), patch.object(run_local, 'default_workspace', return_value=default), patch.object(run_local.http.server, 'ThreadingHTTPServer', Server), contextlib.redirect_stdout(output):
            run_local.main(workspace=workspace)
        return output.getvalue()

    def test_package_defaults_open_distinct_pages(self):
        self.assertIn('http://127.0.0.1:8785/original/', self.launch('original'))
        self.assertIn('http://127.0.0.1:8784/squat/', self.launch('anatomy'))

    def test_explicit_workspace_overrides_package_default(self):
        self.assertIn('http://127.0.0.1:8785/original/', self.launch('anatomy', 'original'))
        self.assertIn('http://127.0.0.1:8784/squat/', self.launch('original', 'anatomy'))

    def test_legacy_and_named_entry_points(self):
        for entry, kwargs in [('run_squat.py', {}), ('run_original.py', {'workspace': 'original'}), ('run_anatomy.py', {'workspace': 'anatomy'})]:
            with patch.object(run_local, 'main') as main:
                runpy.run_path(str(LAUNCHERS / entry), run_name='__main__')
                main.assert_called_once_with(**kwargs)

if __name__ == '__main__': unittest.main()
