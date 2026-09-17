#!/usr/bin/env python3
"""Local coach preview: existing exercise UI, cached examples and browser pose.
Python 3.9+. Geometric 3D needs requirements-preview.txt. The production Flask/ViTPose entry point is intact.
"""
import argparse
import ast
import functools
import http.server
import json
import pathlib
import re
import sys
import threading
import urllib.parse
import webbrowser

# This file lives in launchers/, one level below the repo root — everything
# else it touches (src/, tests/fixtures/) is rooted one level up from here.
ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'src'
sys.path.insert(0, str(SRC))
from local_depth import dispatch as depth_dispatch


def default_workspace():
    config = (SRC / 'anatomy/ui-config.mjs').read_text()
    return 'anatomy' if re.search(r"DEFAULT_UI\s*=\s*['\"]anatomy['\"]", config) else 'original'


def render_index():
    # Reuse the exact original page renderer without importing ML dependencies.
    tree = ast.parse((SRC / 'app.py').read_text())
    names = {'INDEX_HTML', 'PAGES', 'DEFAULT_PAGE', 'IMAGE_SETTINGS_HTML', 'VIDEO_SETTINGS_HTML'}
    keep = []
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in names for t in node.targets):
            keep.append(node)
        elif isinstance(node, ast.FunctionDef) and node.name in {'_tabs_html', 'render_index'}:
            keep.append(node)
    namespace = {'json': json}
    exec(compile(ast.Module(body=keep, type_ignores=[]), str(SRC / 'app.py'), 'exec'), namespace)
    return namespace['render_index']().replace('<head>', '<head><script>window.COACH_LOCAL_PREVIEW=true;</script>', 1)


def examples():
    result = {}
    for scope in ['global', 'local']:
        root = ROOT / 'tests/fixtures' / scope
        manifest = root / 'manifest.json'
        if not manifest.exists(): continue
        for key, entry in json.loads(manifest.read_text()).items():
            clip = root / pathlib.Path(key).parent / entry['source_file']
            track = root / (key + '.track.json')
            if clip.is_file() and track.is_file():
                result[scope + '/' + key] = dict(entry, clip=clip, track=track, scope=scope, label=key)
    return result


class LocalHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.mjs': 'text/javascript', '.js': 'text/javascript',
                      '.wasm': 'application/wasm', '.bin': 'application/octet-stream',
                      '.tflite': 'application/octet-stream', '.data': 'application/octet-stream',
                      '.binarypb': 'application/octet-stream', '.md': 'text/plain; charset=utf-8'}

    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def respond(self, data, kind='application/json', status=200):
        body = data.encode() if isinstance(data, str) else json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if self.command != 'HEAD': self.wfile.write(body)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == '/' and default_workspace() == 'anatomy':
            self.send_response(302); self.send_header('Location', '/squat/'); self.send_header('Content-Length', '0'); self.end_headers(); return
        if path in ('/', '/original/', '/original'): return self.respond(render_index(), 'text/html; charset=utf-8')
        if path == '/api/examples':
            return self.respond([dict(id=k, label=v['label'], scope=v['scope'], stance=v.get('stance'),
                                      notes=v.get('notes', ''), sizes=[v.get('model_size', 'l')]) for k,v in examples().items()])
        if path.startswith('/api/examples/'):
            identifier, _, kind = urllib.parse.unquote(path[len('/api/examples/'):]).rpartition('/')
            entry = examples().get(identifier)
            if not entry or kind not in ['video', 'track']: return self.send_error(404)
            target = entry['clip' if kind == 'video' else 'track']
            self.path = '/fixtures/' + target.relative_to(ROOT / 'tests/fixtures').as_posix()
            return super().do_GET()
        if path == '/api/capabilities': return self.respond({'equipment': False, 'browser_pose': True})
        if path == '/api/depth/methods': return self.depth_route('api_depth_methods')
        match = re.fullmatch(r'/api/profiles/(limbs|signs)', path)
        if match: return self.depth_route('api_profiles', None, match[1])
        if path.startswith('/api/'): return self.respond({'error': 'This local preview uses browser pose. The full Flask backend is available through the original launcher.'}, status=503)
        return super().do_GET()

    def do_HEAD(self):
        self.do_GET()

    def send_head(self):
        self._range_remaining = None
        value = self.headers.get('Range')
        target = pathlib.Path(self.translate_path(self.path))
        if not value or not target.is_file(): return super().send_head()
        size = target.stat().st_size
        match = re.fullmatch(r'bytes=(\d*)-(\d*)', value.strip())
        try:
            if not match or not any(match.groups()): raise ValueError
            first, last = match.groups()
            start = int(first) if first else max(0, size - int(last))
            end = min(int(last), size - 1) if first and last else size - 1
            if not 0 <= start <= end < size: raise ValueError
        except ValueError:
            self.send_response(416)
            self.send_header('Content-Range', f'bytes */{size}')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return None
        stream = target.open('rb')
        stream.seek(start)
        self._range_remaining = end - start + 1
        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(str(target)))
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.send_header('Content-Length', str(self._range_remaining))
        self.end_headers()
        return stream

    def copyfile(self, source, outputfile):
        if self.command == 'HEAD': return
        if self._range_remaining is None: return super().copyfile(source, outputfile)
        remaining = self._range_remaining
        while remaining:
            data = source.read(min(65536, remaining))
            if not data: break
            outputfile.write(data)
            remaining -= len(data)

    def depth_route(self, name, payload=None, *args):
        result, status = depth_dispatch(name, payload, *args)
        return self.respond(result, status=status)

    def read_json(self):
        size = int(self.headers.get('Content-Length', '0'))
        if not 0 < size <= 32 * 1024 * 1024:
            raise ValueError('Expected JSON smaller than 32 MB.')
        return json.loads(self.rfile.read(size))

    def do_POST(self):
        self.close_connection = True
        path = urllib.parse.urlparse(self.path).path
        routes = {'/api/depth/generate': 'api_depth_generate',
                  '/api/depth/optimize_limbs': 'api_depth_optimize_limbs'}
        if path in routes:
            try: payload = self.read_json()
            except (ValueError, UnicodeError) as exc:
                return self.respond({'error': str(exc)}, status=400)
            return self.depth_route(routes[path], payload)
        return self.respond({'error': 'Use browser pose, or the full Flask app for server inference.'}, status=503)

    def do_PUT(self):
        self.close_connection = True
        path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
        match = re.fullmatch(r'/api/profiles/(limbs|signs)/([^/]+)', path)
        if not match: return self.respond({'error': 'Unknown profile route'}, status=404)
        try: payload = self.read_json()
        except (ValueError, UnicodeError) as exc:
            return self.respond({'error': str(exc)}, status=400)
        return self.depth_route('api_profile_save', payload, match[1], match[2])

    def translate_path(self, path):
        path = urllib.parse.unquote(urllib.parse.urlparse(path).path)
        root = ROOT / 'tests/fixtures' if path.startswith('/fixtures/') else SRC
        relative = path[len('/fixtures/'):] if path.startswith('/fixtures/') else path.lstrip('/')
        target = (root / relative).resolve()
        try: target.relative_to(root.resolve())
        except ValueError: return str(root / '__not_found__')
        return str(target)

    def list_directory(self, path):
        self.send_error(404)
        return None

    def log_message(self, fmt, *args):
        if len(args) > 1 and str(args[1]) in ('200', '304'): return
        super().log_message(fmt, *args)


def main(default_path=None, workspace=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', choices=['anatomy','original'], default=workspace or default_workspace())
    parser.add_argument('--port', type=int)
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    if args.port is None: args.port = 8784 if args.workspace == 'anatomy' else 8785
    if default_path is None: default_path = '/squat/' if args.workspace == 'anatomy' else '/original/'
    for path in ['anatomy/models/body.bin', 'squat/vendor/pose/pose.js', 'squat/vendor/pose/pose_landmark_full.tflite']:
        if not (SRC / path).is_file(): parser.exit(1, 'Extract the entire ZIP first. Missing: ' + path + '\n')
    try: server = http.server.ThreadingHTTPServer(('127.0.0.1', args.port), functools.partial(LocalHandler, directory=str(SRC)))
    except OSError as exc: parser.exit(1, f'Cannot open port {args.port}: {exc}\nTry --port 8786\n')
    url = f'http://127.0.0.1:{server.server_port}{default_path}'
    print(f'coach / VERSION 5 / {args.workspace} workspace\n\nOpen {url}\nKeep this window open. Ctrl+C stops the server.\n', flush=True)
    if not args.no_browser: threading.Timer(.5, lambda: webbrowser.open(url)).start()
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()


if __name__ == '__main__': main()
