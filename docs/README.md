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

## Two headsets, two URLs

Hand both links to a colleague and compare them on hardware:

| URL | Built from | Use it for |
|---|---|---|
| `https://3dhermit.github.io/webxr-first-steps/` | `main` | **the lesson a class gets.** Treat this branch as "shipped". |
| `https://3dhermit.github.io/webxr-first-steps/next/` | `anatomy-vr` | a candidate under test — new step, new wording, new asset |

This exists because a free GitHub Pages site has **one** deployment per repo, not one per
branch. So one workflow builds both copies and publishes a single artifact: `main` at the
root, `anatomy-vr` at `/next/`.

One rule to know: **only `main` may publish.** GitHub's `github-pages` environment rejects
deployments from other branches, so a push to `anatomy-vr` runs a build+validate *check* and
the `/next/` preview refreshes on the next publish from `main`. Full explanation in
[deployment](deployment.md#who-is-allowed-to-publish-this-one-bites).

Add `?v=heart1` to the classroom URL to defeat headset caching after a change. Tag the
lesson version in git (`git tag heart-lesson-v1`) and the tag becomes the thing you name in
a staff meeting; the URL never has to change.

**Deploys are gated on content.** `npm run validate` runs before build, for both copies.
Malformed lesson JSON fails the deploy instead of appearing in front of 28 students.

**Check the school network before promising the link.** Many school Wi-Fi networks block
`github.io`. Test from the classroom network on day one, and keep the LAN dev server path
([deployment](deployment.md)) as the fallback.

## Status (2026-11-04)

- **P0/P1 complete**: repo builds and runs; HuBMAP heart asset ingested, optimized
  (4.07 MB → 656 KB) with the part hierarchy intact; generated registry resolves 14/14
  ontology IDs at runtime; exploded view verified visually, not just numerically.
- **Lesson content spine complete**: 5 steps, 12 min, NGSS-anchored (HS-LS1-2, MS-LS1-3),
  every physiology claim traceable to a CC BY source, validated by `npm run validate`.
- **P2 lesson runtime built and desktop-verified**: all 5 steps boot, the flow task
  completes 8/8, reassembly ends reassembled, kiosk reset leaves no residue, no dev hooks in
  student mode, 25–27 draw calls / ~148k triangles.
- **Layout defect closed.** The reading card used to hide ~14% of the exploded cloud because
  it was placed in metres. UI is now authored in **degrees of view** and seated outside the
  anatomy's measured angular footprint — verified **zero anatomy behind the card at all five
  steps**. See [readability](quest2-readability.md#cards-versus-the-organ).
- **Pointing verified through the real ray path.** A retrieval step that "passed 8/8" by
  calling the scoring function directly was measured at 5–6/8 through the controller's own
  ray. Parts that sit behind other parts are now faded *and* removed from the pick set, so no
  task is a dead end: **8/8 core parts reachable**. See [gotchas](gotchas.md).
- **Not yet done**: first real-headset pass (P3), audio cues, second body unit.

## URLs

| URL | Branch | What it is |
|---|---|---|
| <https://3dhermit.github.io/webxr-first-steps/> | `main` | the classroom lesson |
| <https://3dhermit.github.io/webxr-first-steps/next/> | `anatomy-vr` | candidate, for side-by-side testing |

Both come from one workflow and one Pages artifact — see
[deployment](deployment.md).

## House rule

Every interaction in student mode has to name the learning outcome it serves. If it does
not, it belongs in `?debug=1` or in `tools/`. A classroom tool competes with a noisy
room for a 12-year-old's attention; every glowing thing on screen spends that attention.
