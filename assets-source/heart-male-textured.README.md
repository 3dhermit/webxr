# heart-male-textured.glb — PBR source art (not yet used by the app)

UV-unwrapped and textured in Adobe Substance 3D Painter 12.2.0 from `heart-male.glb`
(HuBMAP Human Reference Atlas, "Reference organ — heart, male" v1.3, CC BY 4.0).
Modified: UV-unwrapped and textured (PBR metal/roughness). See `src/assets/anatomy/NOTICE.md`.

- 14 parts, names identical to the original; geometry identical (bounds within 6e-8).
- UVs (TEXCOORD_0) and tangents on every part; one material.
- Embedded 1024x1024 PNG maps: base colour, normal, occlusion/roughness/metallic.

## Must be converted before the app can load it

1. **Duplicate node names.** Painter wrapped each mesh in a same-named group node, so
   three.js renames the mesh `<name>_1` and the app's name lookup matches 0 of 14 parts.
   Collapse the wrapper (or rename) in the optimise step.
2. **Anatomy IDs stripped.** Per-part `extras.ontologyid` (UBERON codes) was dropped
   (14 -> 0). The app keys off parts.json, so this does not break it, but
   `npm run parts` would; copy the extras back from `heart-male.glb`.
3. Compress for the headset (meshopt + KTX2 textures) into `src/assets/anatomy/`.
