# Content sources and licensing

Everything a student reads or sees in this lesson is traceable to one of these. Generated
geometry data (`parts.json`) is not authored content and does not need citation, but it is
derived from source 1.

## 1. Anatomy geometry — HuBMAP / Human Reference Atlas
- Object: *Reference organ — heart, male*, version **v1.3**
- Retrieved: 2026-11-04
- Model: `https://cdn.humanatlas.io/digital-objects/ref-organ/heart-male/v1.3/assets/3d-vh-m-heart.glb`
- Crosswalk: `https://cdn.humanatlas.io/digital-objects/ref-organ/heart-male/v1.3/assets/crosswalk.csv`
- Landing page / canonical citation: `https://purl.humanatlas.io/ref-organ/heart-male/v1.3`
- Licence: **CC BY 4.0**. Attribution ships to the headset as `src/assets/anatomy/NOTICE.md`.
- Used for: part geometry, part identity (`extras.ontologyid` = UBERON:/FMA: terms), real
  metric sizes, and the correct anatomical terms shown on labels.
- What this asset does **not** contain: great vessels (aorta, venae cavae, pulmonary
  trunk/veins), pericardium, coronary arteries. Those appear in the lesson only as labelled
  waypoint markers, never as explodable parts.

## 2. Physiology text — OpenStax, *Anatomy and Physiology*
- Book: Anatomy and Physiology (1e, Rice University / OpenStax CNX, col11496)
- File used: `https://assets.openstax.org/oscms-prodcms/media/documents/AnatomyandPhysiology-OP.pdf`
- Retrieved: 2026-11-04. Chapter 19 *The Cardiovascular System: The Heart*, sections 19.1
  Heart Anatomy, 19.3 Cardiac Cycle, 19.4 Cardiac Physiology.
- Licence: **CC BY 4.0** — stated verbatim in the book: "Anatomy and Physiology is licensed
  under a Creative Commons Attribution 4.0 International (CC BY) license, which means that
  you can distribute, remix, and build upon the content, as long as you provide attribution
  to OpenStax and its content contributors."
- Used for: the blood-flow order, valve names and what the chordae tendineae / papillary
  muscles do, the cardiac cycle and heart sounds, and the review-question stems the quiz
  items are adapted from.
- Student-facing credit line (shown on the lesson end card):
  *Physiology content adapted from OpenStax, Anatomy and Physiology (Rice University),
  Ch. 19 — used under CC BY 4.0.*

## 3. Standards alignment — verified wording
- **HS-LS1-2** (9–12): "Develop and use a model to illustrate the hierarchical organization
  of interacting systems that provide specific functions within multicellular organisms."
  SEP-2 Developing and Using Models; CCC-4 Systems and System Models.
  Source: nextgenscience.org DCI LS1.A page; NSTA NGSS topic sheet HS-StructureAndFunction.
  The NSTA sheet's own worked example of an interacting system is an artery relying on
  elastic tissue and smooth muscle to regulate blood delivery in the circulatory system.
- **MS-LS1-3** (6–8): "Use argument supported by evidence for how the body is a system of
  interacting subsystems composed of groups of cells." Its assessment boundary **includes
  the circulatory system** (and excretory, digestive, respiratory, muscular, nervous).
  CCC-4 Systems and System Models; SEP-7 Engaging in Argument from Evidence.
  Source: nextgenscience.org; CDE CA NGSS standards record MS-LS1-3.
- **4-LS1-1** (3–5) exists for the same idea at a younger band; not used in this lesson.

## What is NOT sourced
Explode axes, spread distances and tiers are computed from geometry (`tools/parts-gen.mjs`)
or chosen for legibility, and are not anatomical claims.
