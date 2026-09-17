# BodyParts3D anatomical surfaces

BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International.

- [Official database licence](https://dbarchive.biosciencedbc.jp/en/bodyparts3d/lic.html), updated 2025-02-27.
- [CC BY 4.0 terms](https://creativecommons.org/licenses/by/4.0/).
- [Official downloads](https://dbarchive.biosciencedbc.jp/en/bodyparts3d/download.html): `isa_BP3D_4.0_obj_99.zip`.
- [Original publication](https://doi.org/10.1093/nar/gkn613): Mitsuhashi et al., *BodyParts3D: 3D structure database for anatomical concepts* (2009).

This local build bundles **337 actual source meshes**, with **1,324,762 triangles**:
skeletal surfaces, selected major muscles and iliotibial tracts. These replace the earlier generated
primitive anatomy completely. It is an adult male atlas, not this lifter's scan,
and the selected subset is not a complete inventory of human muscles.

Acquisition: unchanged source OBJ files from the public
[jixiangying/anatomy mirror](https://github.com/jixiangying/anatomy/tree/be67a977abe25a36f59793fda86a506618fd4d27/isa_BP3D_4.0_obj_99),
commit `be67a977abe25a36f59793fda86a506618fd4d27`.
Source file IDs, Git blob SHAs, SHA-256 digests and FMA concepts are recorded
per mesh in `body.json`. Names and concept IDs come from OBJ headers, with a
metadata fallback for the one unnamed source component.

The metadata cross-reference came from
[Human Atlas](https://github.com/ashemag/human-atlas/blob/1c38bf35c254a891200d3cedecfd57abebe83d8d/public/ATTRIBUTION.md),
which preserves BodyParts3D identities. No Human Atlas application code or
binary geometry is used. The mirror's AI-generated translations are not used.

Adaptations in this build: selected surfaces; converted millimetres/Z-up to
metres/Y-up, translated by `(0, +0.0781112, -0.1)` after axis conversion;
triangulated faces and packed indexed Float32/Uint32 buffers; recomputed
normals; added approximate regional rigging and group colours. Geometry is
unchanged in topology from the selected OBJ files. Skinning is an engineering
adaptation, not an original DBCLS motion model or an endorsed biomechanical
simulation. Attribution does not imply endorsement.

Legacy OBJ comments refer to CC BY-SA 2.1 Japan. The current official database
page explicitly licenses the database under CC BY 4.0. This distribution uses
that current grant; original provenance remains recorded in the manifest.

Reproduce the packing from the project root with:

```sh
python scripts/build_anatomy.py /path/to/source/obj scripts/anatomy-selection.json
```

The selection records the pinned source paths and blob SHAs. Source meshes
are needed only to rebuild; the preview runs from the bundled packed files.
Tissue labels and attachment rules correct ambiguous name substrings such
as tibialis/tibia and the laryngeal/foot uses of “cuneiform.”

Three.js keeps its own
MIT licence in `src/squat/vendor/THREE-LICENSE.txt`.
