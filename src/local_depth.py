"""Run the project's geometric depth/profile routes without loading ViTPose.

The route bodies and validators come directly from app.py so the lightweight
launcher and the full Flask application use the same reconstruction settings.
Each request gets its own namespace; request data cannot leak between threads.
"""
import ast
import functools
import json
import pathlib
import re
from types import SimpleNamespace

SOURCE = pathlib.Path(__file__).with_name('app.py')
FUNCTIONS = {
    'api_depth_methods', 'api_depth_generate', 'api_depth_optimize_limbs',
    '_builtin_profiles', '_parse_profile', '_profile_path', '_read_profiles',
    'api_profiles', 'api_profile_save',
}
CONSTANTS = {'FIXTURES_DIR', 'FIXTURE_SCOPES', 'PROFILE_KINDS',
             'PROFILE_NAME_RE', 'DEFAULT_LIMB_PROFILE'}


@functools.lru_cache(maxsize=1)
def route_code():
    keep = []
    for node in ast.parse(SOURCE.read_text()).body:
        if isinstance(node, ast.FunctionDef) and node.name in FUNCTIONS:
            node.decorator_list = []
            keep.append(node)
        elif isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id in CONSTANTS for t in node.targets):
            keep.append(node)
    return compile(ast.Module(body=keep, type_ignores=[]), str(SOURCE), 'exec')


def dispatch(name, payload=None, *args):
    try:
        import depth_backend
    except ImportError:
        return {'error': 'The local 3D backend needs numpy and OpenCV. Run '
                'python -m pip install -r requirements-preview.txt, then restart.',
                'methods': []}, 503
    namespace = {'__file__': str(SOURCE), 'Path': pathlib.Path, 're': re,
                 'json': json, 'depth_backend': depth_backend,
                 'request': SimpleNamespace(get_json=lambda **kw: payload),
                 'jsonify': lambda value: value}
    exec(route_code(), namespace)
    result = namespace[name](*args)
    return result if isinstance(result, tuple) else (result, 200)
