# Asset pipeline

## Where the anatomy comes from

| | |
|---|---|
| Source | HuBMAP / **Human Reference Atlas** 3D Reference Object Library |
| Object | *Reference organ — heart, male*, **v1.3** |
| Landing page | https://purl.humanatlas.io/ref-organ/heart-male/v1.3 |
| GLB | https://cdn.humanatlas.io/digital-objects/ref-organ/heart-male/v1.3/assets/3d-vh-m-heart.glb |
| Crosswalk | https://cdn.humanatlas.io/digital-objects/ref-organ/heart-male/v1.3/assets/crosswalk.csv |
| License | **CC BY 4.0** — attribution required, commercial use fine |
| Retrieved | 2026-11-04 |

Attribution is shipped **to the headset**, not just in the repo, because that is where the
model is actually seen: `src/assets/anatomy/NOTICE.md` plus a monitor-visible strip.

> Anatomy model: HuBMAP Human Reference Atlas, "Reference organ — heart, male" (v1.3),
> used under CC BY 4.0. Source: https://purl.humanatlas.io/ref-organ/heart-male/v1.3

For a school product this matters twice: you need a license that survives being used in a
district, and you need a source a science department will trust. A reference atlas built
from real tissue data beats a free model with unknown provenance, and ontology IDs come
free with it.

## What the asset actually is (measured, not assumed)

```
file            4.07 MB  heart-male.glb
triangles       164,119
nodes / meshes  18 / 14            (1 root → 3 system groups → 14 meshed parts)
textures        0
materials       ONE shared material, "heart_mat", used by all 14 parts
bounding box    0.120 × 0.113 × 0.094 m   (a real heart: ~12 cm)
identity        node.extras → { ontologyid, label, representation_of }
crosswalk       16 structures with UBERON/FMA ids and human labels
```

Three of those numbers shaped the code:

- **one shared material** → highlight/ghost/isolate must clone materials per part at
  load, or highlighting a ventricle highlights the whole heart;
- **12 cm real size** → every distance, text size and explode offset in the runtime is in
  metres against a 12 cm object. Fingers-pointing at a 3 cm valve is a real ergonomics
  problem, which is why hit aids exist;
- **no great vessels in the mesh** (no aorta, venae cavae, pulmonary trunk) → the
  circulation path has to be drawn as **labelled schematic waypoints** anchored to real
  parts, and the UI says so. See [lesson authoring](lesson-authoring.md).

## Optimization: the flag that saves the project

```bash
npx @gltf-transform/cli optimize in.glb out.glb \
  --compress meshopt --meshopt-level high \
  --flatten false --join false --instance false --palette false
```

`4.07 MB → ~656 KB`, and the node names and hierarchy survive, so the runtime still
resolves **14/14** ontology IDs.

**The three `false` flags are not optional.** glTF-Transform v4 defaults `--join` and
`--flatten` to true. Those passes are *graph rewrites*: they merge meshes and collapse
node trees to make rendering cheaper. For a normal viewer that is a win. For this project
it is fatal — the node tree **is** the addressable anatomy. Flatten it and you can no
longer point at, hide, or move a single part. We trade a few draw calls (we are at 25,
against a gate of <100) for the ability to teach.

## Payload hygiene

`webpack.config.cjs` uses `CopyPlugin` with `{ from: 'src/assets', to: 'assets' }` — it
copies **everything** under `src/assets`. The first build after asset ingest shipped the
4 MB unoptimized source to the headset alongside the 656 KB runtime copy (4.6 MB total).

Fix, and the rule that comes with it: **anything raw belongs outside `src/assets`.**

```
assets-source/heart-male.glb          4 MB  raw HuBMAP export  → NOT shipped
assets-source/heart-male.crosswalk.csv                        → NOT shipped
src/assets/anatomy/heart-male.opt.glb 656 KB                   → shipped
src/assets/anatomy/parts.json         generated registry       → shipped
src/assets/anatomy/NOTICE.md          attribution              → shipped
```

Current payload: anatomy **656 KB** against a **<20 MB** per-lesson target. `dist/` reports
~15 MB because the blaster tutorial's GLBs also ship, but a lesson load never requests
them — they are fetched on demand only in `?demo=tutorial` mode. 28 headsets loading 656 KB
at once is not a network event worth designing around.

**Never make the whole-body HuBMAP model the default payload**: 7.19 M triangles, roughly
ten times the Quest 2 frame budget on its own. If a later unit needs it, it needs chunked
loading and a per-region plan, not a bigger file.

## Regenerating the registry

```bash
npm run parts   # node tools/parts-gen.mjs assets-source/…glb assets-source/…csv src/assets/anatomy/parts.json
```

`parts-gen.mjs` is dependency-free (no npm install needed to regenerate) and writes:
ontology id, asset label, triangle count, measured size, true geometry centre, and the
**auto-solved explode vector**. The solver spreads parts along anatomical axes and
resolves overlaps — it went from 10 overlapping pairs to 0 at spreads of 0.05–0.35 m.
That generated data seeds the hand-tuned `explodeGain` in the lesson JSON; it does not
replace it, because the final spread is a readability judgement, not a geometry fact.

The registry deliberately holds **no teaching text**. If pedagogical fields end up in a
generated file, they will be wiped on the next `npm run parts`.
