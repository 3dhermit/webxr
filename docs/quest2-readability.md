# Quest 2 limits and readability

## The performance gate (Quest 2, WebXR)

| Budget | Value | Consequence here |
|---|---|---|
| Refresh | 90 Hz default, 72 Hz allowed | ~11.1 ms per frame for JS **plus both eyes** |
| Draw calls | < 100 | part *count* is the constraint; lesson measures **25** |
| Triangles / frame | < 750k (comfortable ~150k) | heart ships at **~148k** |
| Foveation | supported | `renderer.xr.setFoveation(1)` |
| Depth sensing / scene mesh | absent | no MR features |
| Passthrough | grayscale, low-res | design VR-only |
| Input | Touch controllers | ray pointing only; no hand-tracking UX |
| RAM | ~4 GB | anatomy payload **656 KB** |
| DOM overlay in `immersive-vr` | **not supported** | every label, panel and button is in-world geometry |

Verified desktop numbers for the whole lesson: **25–27 draw calls, ~148k triangles,
32 geometries, 9 programs**. The organ is 14 parts, so this is not close to the gate —
the gate matters the moment a second body region is added.

## Why the monitor is not the test surface

A desktop window at 45° FOV is not a Quest. Text that measured ~55 px in a desktop capture
read **~7 px** in the headset view — not legible. Convert instead:

- Quest 2: ~1832 px/eye across ~99° horizontal → **≈ 18.5 px per degree of view**.
- Target **≥ 1°** of visual angle for body text (≈ 19 px on lens). Verified settings:
  prompt **1.3°**, feedback **1.15°**, waypoint labels ~0.017 m at 0.62 m.
- Desktop preview must approximate that: `camera.fov = 88` (Quest-like vertical FOV) and the
  orbit camera parked at the student's eye height, target = model centre.

## Cards versus the organ

Both the reading card and the anatomy have to live in the same field of view, and the sizes
that look sane in metres can be enormous in degrees: a 0.28 m card at 0.34 m covers **44°**,
while the exploded cloud measured **~32° wide**. A metre-based placement hid 14% of the
cloud.

The fix is to author layout in **degrees of view** and place the card outside the anatomy's
measured footprint:

1. `AnatomyModel.angularExtents(eye)` — every part projected relative to the **student's
   eye**, giving the cloud's azimuth/elevation band.
2. `Lesson.planUi()` — reads degree specs from lesson JSON and converts them to metres at
   the chosen panel depth, then seats the card beside the band plus `panelGapDeg`.
3. Assert in screen space: project all 14 parts and the card, count parts behind the card.
   **Verified: zero at all five steps.**

Current authored values (`src/lessons/heart.json` → `runtime.ui`):

```
panelSide left | panelAngularWidthDeg 20 | panelGapDeg 5 | panelDepthMetres 0.62
panelBottomElevDeg -13 | promptTextDeg 1.3 | feedbackTextDeg 1.15
buttonAzDeg 30 | buttonElevDeg -22 | buttonWidthDeg 13 | maxComfortAzDeg 45
eyeHeightMetres 1.45
```

## Table placement (measured, not assumed)

A 15 cm heart is not study-sized. Scaling it up is not enough — the centre has to sit near
the eye line, or the student spends the lesson looking down at the top of a heart:

- `modelScale 2.4`, `distanceMetres 0.7`, `heightAboveFloorMetres 1.34`, `explodeGain 0.27`
- at 1.12 m height the centre sat **28° below** the sightline; raising the table to ~1.34 m
  brings it within ~10°
- labels live on a sphere centred on the **eye** with ≥ 12° azimuth / ≥ 6° elevation gaps,
  and only the parts the current step needs are labelled (4 chamber names, not 8 full names —
  eight long names physically do not fit one arc)

## Check before trusting a readability pass

- Boxes projected to screen space: zero overlap, all inside frame
- Glyph height converted to degrees, not pixels
- Panel backdrop height ≈ measured text height (`_textRenderInfo.blockBounds`)
- Labels single-line
- Screenshot taken from the student-seat camera with `fov 88`, never a 3.5 m pull-back
