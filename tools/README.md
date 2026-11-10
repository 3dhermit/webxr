# Anatomy tooling

Two scripts back every anatomy lesson. Neither needs a dependency install.

## 1. Build the registry — `parts-gen.mjs`

Reads the **original** (uncompressed) GLB plus the Human Reference Atlas crosswalk, walks
node world matrices to get true metric part sizes/centres, then writes the registry the
runtime actually uses (`parts.json`): id, label, system, explode axis, spread in metres.

```bash
node tools/parts-gen.mjs \
  assets-source/heart-male.glb \
  assets-source/heart-male.crosswalk.csv \
  src/assets/anatomy/parts.json
```

It also runs an auto-explode solver: seed each spread from the part's own size, grow it
until the part bounding spheres stop overlapping, and relax the axis when a pair can only
separate sideways. Verified run: 10 overlapping pairs -> 0, spreads 0.05-0.35 m.

Per-part identity comes from the GLB's own `node.extras` (`ontologyid`, `label`) when
present; the CSV is the fallback, not the requirement.

## 2. Optimise for the headset — gltf-transform

```bash
npx @gltf-transform/cli@4 optimize \
  assets-source/heart-male.glb src/assets/anatomy/heart-male.opt.glb \
  --compress meshopt --meshopt-level high \
  --flatten false --join false --instance false --palette false
```

The four `false` flags are **not optional**: v4 defaults `--join`/`--flatten` to true, which
merges parts and destroys the per-part identity (and therefore the whole lesson). This step
took 4.07 MB -> 656 KB while preserving every node name.

## 3. Verify in a browser before touching VR — `probe-anatomy.html`

Serve the repo root and open `tools/probe-anatomy.html`:

```bash
python -m http.server 8140     # then http://127.0.0.1:8140/tools/probe-anatomy.html
```

It loads the shipped GLB with the repo's pinned three.js, resolves the registry, clones
materials, and prints draw calls / triangles / id coverage / solver numbers against the
Quest 2 budget. It exposes `window.__xr.setFactor(0..1)` so an agent (or you) can drive the
explode deterministically instead of hoping an animation frame lands.

## Where originals live

`assets-source/` sits **outside** `src/` on purpose: webpack's CopyPlugin copies all of
`src/assets` into `dist`, so keeping the uncompressed 4 MB source there ships 4 MB to the
headset. Only the optimised GLB, the registry and the attribution notice belong in
`src/assets/anatomy` (measured shipped payload: 656 KB).

## Textured model from Substance 3D Painter

Painter's glTF export cannot be loaded as-is: it wraps every mesh in a same-named group
(three.js then renames the mesh `<name>_1`, and parts.json matches 0 of 14 parts) and it
drops the per-part `extras`. Fix, then optimise:

```bash
node tools/painter-glb-fix.mjs <painter-export.glb> assets-source/heart-male.glb fixed.glb
npx @gltf-transform/cli@4 optimize fixed.glb src/assets/anatomy/heart-male-textured.opt.glb \
  --compress meshopt --meshopt-level high --texture-compress webp --texture-size 1024 \
  --flatten false --join false --instance false --palette false
```

Keep the four `false` flags: their defaults merge parts and destroy per-part identity.
In Painter, keep the 14 mesh names, origins and transforms untouched, and use one texture
set (glTF has no UDIMs). Which model loads is `runtime.modelUrl` in the lesson JSON;
`runtime.modelColour` is `texture` (painted maps) or `system` (body-system tint on top).
