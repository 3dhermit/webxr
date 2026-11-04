# VR Anatomy — project wiki

A WebXR teaching tool for a classroom of Meta Quest 2 headsets. The student puts on a
headset, studies a real reference heart, and learns the circulatory system by
disassembling it, tracing blood flow, and reassembling it from memory.

This wiki documents **how the project works and why it is built this way**. It is kept in
the repo on purpose: the docs travel with the commit that changed the behaviour, and a
reviewer sees doc and code drift in the same diff. The GitHub wiki is a separate git
repository that drifts silently and is not covered by CI — use it for scratch notes, not
for the engineering record.

## Quick start

```bash
npm install
npm run dev          # https://localhost:8081  (self-signed; LAN reachable on 0.0.0.0)
npm run build        # dist/ — what actually ships
npm run validate     # lesson JSON vs geometry registry — the deploy gate
npm run parts        # regenerate the geometry registry from the source GLB
```

Four entry modes on one page (all query-string, no builds per audience):

| URL | Audience |
|---|---|
| `index.html` | **student** — the default. No HUD, no dev surfaces, resets on every load. |
| `index.html?level=ms` | same lesson, younger reading register (grades 6–8) |
| `index.html?debug=1` | desktop-only developer HUD + arrow-key step stepping |
| `index.html?demo=tutorial` | the original `webxr-first-steps` blaster tutorial, kept working |

## Pages

| Page | What it answers |
|---|---|
| [Architecture](architecture.md) | how the code is arranged, how lesson data becomes behaviour |
| [Asset pipeline](asset-pipeline.md) | where the anatomy comes from, licensing, keeping it small |
| [Lesson authoring](lesson-authoring.md) | the content schema, the validator, adding a body region |
| [Quest 2 limits & readability](quest2-readability.md) | the performance gate, and why "it looked fine on the monitor" is not evidence |
| [Deployment & dev loops](deployment.md) | Pages, the `/next/` preview, the three dev loops, kiosk rollout |
| [Gotchas](gotchas.md) | the bug catalog — every one of these cost real debugging time |

## Status (2026-11-04)

- **P0/P1 complete**: repo builds and runs; HuBMAP heart asset ingested, optimized
  (4.07 MB → 656 KB) with the part hierarchy intact; generated registry resolves 14/14
  ontology IDs at runtime; exploded view verified visually, not just numerically.
- **Lesson content spine complete**: 5 steps, 12 min, NGSS-anchored (HS-LS1-2, MS-LS1-3),
  every physiology claim traceable to a CC BY source, validated by `npm run validate`.
- **P2 lesson runtime built and desktop-verified** (`a1fd5fa`): all 5 steps boot, flow
  task completes 8/8, reassembly ends reassembled, kiosk reset leaves no residue, no dev
  hooks in student mode, 25 draw calls / ~148k triangles.
- **Open defect**: the reading card still overlaps ≈14% of the exploded cloud in angular
  view space (measured today: 14.6° elevation × 14.4° azimuth). Better than a centred
  card, not yet clean. See [readability](quest2-readability.md#cards-vs-the-organ).
- **Not yet done**: first real-headset pass (P3), audio cues, second body unit.

## House rule

Every interaction in student mode has to name the learning outcome it serves. If it does
not, it belongs in `?debug=1` or in `tools/`. A classroom tool competes with a noisy
room for a 12-year-old's attention; every glowing thing on screen spends that attention.
