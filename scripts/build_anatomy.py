# SPDX-License-Identifier: AGPL-3.0-or-later
"""Pack unmodified BodyParts3D OBJ surfaces into indexed browser geometry.

Usage: python scripts/build_anatomy.py SOURCE_OBJ_DIR selected.json
Only positions, triangles and source identity are retained. Axis/unit conversion
is documented in src/anatomy/models/ATTRIBUTION.md. No primitive replacements.
"""
import array
import hashlib
import json
import pathlib
import re
import sys

source = pathlib.Path(sys.argv[1])
selection = json.loads(pathlib.Path(sys.argv[2]).read_text())
out = pathlib.Path(__file__).resolve().parents[1] / 'src/anatomy/models'
out.mkdir(parents=True, exist_ok=True)
payload = bytearray()
parts = []
for entry in selection:
    path = source / (entry['id'] + '.obj')
    text = path.read_text()
    positions, indices = [], []
    for line in text.splitlines():
        if line.startswith('v '):
            x, y, z = map(float, line.split()[1:4])
            positions.extend([x / 1000, z / 1000 + .0781112, -y / 1000 - .1])
        elif line.startswith('f '):
            face = [int(v.split('/')[0]) - 1 for v in line.split()[1:]]
            for i in range(1, len(face) - 1):
                indices.extend([face[0], face[i], face[i + 1]])
    assert positions and indices and min(indices) >= 0 and max(indices) < len(positions) // 3
    part = {k: entry[k] for k in ('id', 'name', 'conceptId', 'system')}
    # Source OBJ headers, not a translated/AI classification, are authoritative.
    for line in text.splitlines()[:25]:
        if line.startswith('# English name : ') and line.split(' : ', 1)[1].strip():
            part['name'] = line.split(' : ', 1)[1]
        if line.startswith('# Concept ID : ') and line.split(' : ', 1)[1].strip():
            part['conceptId'] = line.split(' : ', 1)[1]
    # Correct the selection metadata's substring-based tissue classification.
    # These source-named muscles are not the similarly named bones.
    if re.search(r'fibularis|tibialis|subscapularis|levator scapulae', part['name'], re.I):
        part['system'] = 'muscular'
    if 'iliotibial tract' in part['name'].lower():
        part['system'] = 'connective'
    part.update(positions=len(payload), vertexCount=len(positions) // 3,
                sourceSHA=entry['source']['sha'], sourceSHA256=hashlib.sha256(path.read_bytes()).hexdigest())
    values = array.array('f', positions)
    if sys.byteorder != 'little': values.byteswap()
    payload.extend(values.tobytes())
    part.update(indices=len(payload), indexCount=len(indices))
    values = array.array('I', indices)
    if sys.byteorder != 'little': values.byteswap()
    payload.extend(values.tobytes())
    part['bounds'] = [[min(positions[i::3]) for i in range(3)], [max(positions[i::3]) for i in range(3)]]
    parts.append(part)
(out / 'body.bin').write_bytes(payload)
(out / 'body.json').write_text(json.dumps({
    'version': 'BodyParts3D 4.0 / coach subset 2', 'parts': parts,
    'sourceRepository': 'jixiangying/anatomy',
    'sourceCommit': 'be67a977abe25a36f59793fda86a506618fd4d27',
    'license': 'CC-BY-4.0', 'bytes': len(payload),
    'sha256': hashlib.sha256(payload).hexdigest(),
    'triangles': sum(p['indexCount'] // 3 for p in parts),
}, separators=(',', ':')))
print(f'{len(parts)} real anatomical meshes; {len(payload):,} bytes; '
      f'{sum(p["indexCount"] // 3 for p in parts):,} triangles')
