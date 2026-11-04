# Gotchas — the bug catalog

Every entry here cost debugging time in this project. Ordered roughly by how much.

## Geometry and assets

**Flattening a quantized GLB by hand.** `KHR_mesh_quantization` stores the dequantization
scale on *ancestor* nodes. Re-parenting meshes into a flat group and resetting their TRS
inflates geometry ~10× and collapses parts onto each other — a 3 cm valve measured
`size: 0.297`. Keep the glTF hierarchy; use each mesh's own LOCAL position as `home` and
map world-space explode offsets through `parent.matrixWorld` inverse.

**`gltf-transform optimize` defaults destroy a part-addressable model.** `--join`,
`--flatten`, `--instance`, `--palette` all default **true**, merging parts and materials.
Always: `--join false --flatten false --instance false --palette false`. v4 has
`--meshopt-level`, not `--level`.

**All 14 heart parts share one material** (`heart_mat`), so isolate/highlight does nothing
until you `material.clone()` per part. Check with
`new Set(parts.map(p => p.material.uuid)).size`.

**`traverse()` + re-parenting** mutates `children` mid-iteration and runs off the end
(`Cannot read properties of undefined (reading 'traverse')`). Collect meshes into an array
first, then mutate.

**Node origin ≠ geometry centre.** The HRA parts are not centred on their node origins;
measured model centre sat at **y = −0.12** while the eye was at 1.45, so labels anchored to
`group.getWorldPosition()` landed a metre below the heart. Use the parts' geometry centroid
(`Box3.setFromObject(mesh)`), not the group origin.

**A solver that reports "0 overlaps" can still look like a fused blob.** Bounding-sphere
clearance over-separates shell parts. Explode quality is judged visually.

## Layout and text

**Metres are the wrong unit for UI.** A 0.28 m card at 0.34 m spans ~44° of view while the
exploded cloud was ~32° wide, so a "put it to the left" card still hid **14% of the
anatomy**. Place UI outside the anatomy's **measured angular footprint** from the eye
(`AnatomyModel.angularExtents(eye)`), authored in degrees in lesson JSON.

**troika 0.49.1 has no `textDimensions`.** Reading it yields `undefined`, the panel falls
back to its minimum box, and text spills across the organ: backdrop measured **0.076 m**
against real text **0.302 m**. Read `_textRenderInfo.blockBounds` (`[minX,minY,maxX,maxY]`)
after sync — and refit *inside* `sync(callback)`, because sync is async.

**In-world labels must not wrap.** `maxWidth: 0.16` at a 0.022 m font turned
`Right atrium` into three stacked lines. One line, generous `maxWidth` (~1.2 m); angular
placement handles collisions.

**Monospace line height.** Space Mono's `lineHeight: normal` is ~2.1 em, so a 202-character
prompt became ~19 line-heights tall. Set `lineHeight` explicitly.

**Ring spacing measured around the model centre collapses on the retina.** A run asking for
26° gaps measured **1.2°** actual, one label 55° below the sightline. Space labels in the
student's own azimuth/elevation from the **eye**.

**Fixed `lookAt` on UI goes edge-on** when the student moves their head. Copy the camera
quaternion to every UI part each frame.

## Pointing and interaction

**Calling `select(id)` proves the scoring logic, not that a student can hit the part.**
Retrieval reported 8/8 that way while the real controller ray found 5–6/8. Verify with the
ray the controller builds, aimed at sampled **surface** points (bbox corners + face centres).

**A valve's bounding box is mostly hole.** 25–46 mm reads "big enough", but the hole is
exactly where a student aims. Hollow parts (`spec.system === 'valve'`) always get an aim aid.

**Hit-aid scale must divide by the mesh's real world scale** (`getWorldScale`), not the
group's — a quantized GLB carries scale on ancestors, and the group's divisor produced
sub-millimetre aids.

**A part behind another part is a stuck student.** Rotating the organ fixed reachability
(8/8 at 240–270° yaw) but destroys the canonical anterior view — and "the atria sit
posterior" is itself the lesson. Instead: `pickAll()` the ray, ghost the blockers, **and**
take them out of the pick set (`only:`), because translucent geometry is still solid to a
raycast. Verified 8/8 reachable after that.

**Ghosting without excluding from picking does nothing** for reachability — it only looks
helpful.

**Never ship help text promising an unverified remedy.** A hint said "lean sideways and
point at it"; sliding the eye 0–0.4 m never exposed the left atrium. That would have taught
students the app was broken.

## Probing and verification

**`model.parts` is a `Map`.** `Object.keys(model.parts)` silently iterates zero items, so a
broken assertion reads as a pass. Use `[...model.parts.keys()]`.

**Background/occluded tabs throttle `requestAnimationFrame`.** An animated check renders one
frame and freezes; `renderer.info` then reported `drawCalls: 1`. Expose a setter
(`setFactor`) that applies state, renders, and reports.

**A draw-call count that DROPS after exploding (14 → 11) is geometry leaving the frustum**,
not a cheaper scene. Auto-frame on the exploded extent.

**Interpolating raw registry fields into student text** produced "it is chamber." Build
feedback from lesson vocabulary (`partName()` + `factFor()`).

**A kiosk reset that only resets the step counter** leaves flow progress, tweens,
highlights, ghost opacity, hover text and panel text from the previous student. Reset must
re-prime queues and clear model look state.

**`say('')` does not clear a panel** when the helper early-returns on falsy input. Add an
explicit `clearSay()`.

## Verification discipline

Two passes in this project were **false greens**: retrieval "8/8" that never went through a
ray, and a card "fit" check reading a nonexistent property. Both looked like passes. The
rule that came out of them: *test through the path the user's actual input takes, and assert
on measured values, never on the absence of an error.*
