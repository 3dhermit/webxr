# Lesson authoring

The lesson is a JSON file a curriculum writer can edit: `src/lessons/heart.json`. The
runtime reads it; no pedagogical decision lives in JavaScript.

## Shape of the file

```jsonc
{
  "id": "heart-circulation",
  "version": 1,                  // bump when content changes; tags mark releases
  "level": "hs",                 // default register
  "levels": { "hs": "grades 9–12", "ms": "grades 6–8" },
  "time": { "core": 12, "detail": 18 },     // minutes
  "standards": [ "HS-LS1-2", "MS-LS1-3" ],
  "objectives": [ … ],
  "steps": [ {
      "id": "s3-valves", "verb": "isolate", "minutes": 3,
      "prompt": "…what the student reads in-world…",
      "outcome": "o2",
      "misconception": "m2",       // what we expect them to get wrong, and answer in the feedback
      "actions": { "isolate": ["UBERON:0002084"], "ghost": ["UBERON:0002080"],
                   "explode": 0.25, "hoverNames": true }
  } ],
  "names": { "UBERON:0002084": "Left ventricle", … },   // what a student sees
  "vocab": { "UBERON:0002137": "The aortic valve guards the door to the body's main artery." },
  "flow": { "steps": [ …12 hops, 8 anchored to real parts… ],
            "waypoints": { "fromBody": "From the body", "toLungs": "To the lungs", … } },
  "quiz": [ …4 items, each linked to an objective… ],
  "runtime": { "explodeGain": 0.27, "hitSphereMinMetres": 0.025,
               "tablePlacement": { … }, "ui": { … } }
}
```

Current content: **5 steps, 12 min core / 18 with detail, 14 parts (core 8 + detail 6),
flow 12 hops (8 real parts), quiz 4**. `npm run validate` prints those numbers so a
regression in content is visible as a diff in the log, not discovered in a classroom.

## The step verbs

| verb | what it does | why a teacher wants it |
|---|---|---|
| `explode` | 0–1 disassembly scalar (or `[from,to]` to tween) | take the organ apart to see inside |
| `labels` | `"none"` or an explicit list of part ids | control what is named *right now* — a wall of 8 names is unreadable in a headset |
| `hoverNames` | name the part the ray is on | let the student explore vocabulary at their own pace |
| `isolate` / `ghost` | show only these / fade these to context | direct attention without hiding the relation |
| `flow` | schematic circulation path with waypoint markers | teach movement the static mesh cannot show |
| `reassemble` | student retrieves parts in order | the assessment is *doing*, not multiple choice |

## Standards anchors

- **HS-LS1-2** — *Develop and use a model to illustrate the hierarchical organization of
  interacting systems that provide specific functions within multicellular organisms.*
  Practice: SEP-2 Developing and Using Models. Concept: CCC-4 Systems and System Models.
- **MS-LS1-3** — *Use argument supported by evidence for how the body is a system of
  interacting subsystems composed of groups of cells.* (Circulatory system is inside the
  assessment boundary.)

The medium is the argument: an exploded organ *is* a systems model, which is why the
disassembly is the lesson rather than decoration around it.

## Content grounding

| Claim type | Source | License |
|---|---|---|
| geometry + anatomical terminology | HuBMAP HRA heart-male v1.3 | CC BY 4.0 |
| physiology wording (flow, pressures, valve function) | OpenStax *Anatomy and Physiology*, ch. 19 | CC BY 4.0 |

`content/SOURCES.md` holds the provenance. Practical note from authoring it: OpenStax's
2e **web page** is a JS app shell — both `curl` and a real browser returned a cookie wall,
and the direct 2e PDF link was dead (243 bytes). The live A&P **1e direct PDF** worked and
contains the license line verbatim: *"Anatomy and Physiology is licensed under a Creative
Commons Attribution 4.0 International (CC BY) license."* For citation work, go to the
static document, not the site.

## What the validator enforces (`npm run validate`)

This exists because the lesson file references geometry it does not own, and drift is
silent until a part is missing on stage.

- every part id used by a step, the flow path, the vocab or the quiz **exists in
  `parts.json`** — no invented anatomy;
- the student-facing `names` map **covers every core pointable part** and cannot name a
  part the asset does not have;
- every objective is **taught by a step** (this one caught a real hole: objective `o4`
  appeared in the list and nowhere in the lesson);
- tier counts and the declared minute budget match what the steps actually add up to;
- quiz items link to real objectives.

Run it locally, and it also runs in CI as the deploy gate — see
[deployment](deployment.md).

## Honest-schematic rule

The HRA heart mesh contains **no great vessels**. So the circulation path is drawn as
labelled waypoints (`From the body`, `To the lungs`, `From the lungs`, `To the body`)
anchored to real parts, and marked as a schematic.

Two reasons this is a rule and not a footnote: a student who is shown an imagined vessel
as part of the model will carry that into a diagram test; and the mismatch is a teaching
opportunity ("the vessels are not in this model — here is where they would be").

Waypoint labels are short directional phrases, not full physiological annotations. Measured
in angular view space, long annotations collide with each other at Quest optics; short ones
survive. See [readability](quest2-readability.md).

## Adding a body region (the recipe)

1. Pick a reference object from the HRA library; confirm **license + that its parts are
   addressable** (a mesh with one material and no per-part nodes cannot support
   isolate/point tasks).
2. Download GLB + crosswalk into `assets-source/` (**never** `src/assets/`).
3. Optimize with the graph passes off; measure tris and file size against the Quest gate.
4. `npm run parts` → new `parts.json`.
5. Copy the tier logic: measure part sizes, decide which parts are pointable targets.
6. Author `src/lessons/<region>.json`: names, vocab, steps, flow, quiz, runtime.
7. Point `npm run validate` at it, fix the drift, then build.

Code you should **not** have to touch: `lesson.js`, `anatomy.js`, `text.js`. If you find
yourself editing them to add a unit, the data model has a hole — fix the hole instead.
