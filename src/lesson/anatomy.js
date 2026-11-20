/**
 * Anatomy model: loads the optimized HRA heart, joins it to the generated geometry registry,
 * and exposes the teaching verbs (explode / isolate / ghost / highlight / assemble-one-part).
 *
 * Three non-obvious rules baked in here:
 *  - Do NOT flatten the glTF. KHR_mesh_quantization carries dequantization scale on ancestor
 *    nodes; reparenting meshes and resetting TRS inflates them ~10x and collapses the model.
 *  - HRA ships ONE material shared by all parts, so per-part colour/highlight needs a clone.
 *  - Exploding is HYBRID: the 9 major parts ride baked 2.5 s clips (eased multi-keyframe
 *    positions, authored per part) on a shared AnimationMixer; the 5 papillary muscles have no
 *    clips of their own and stay procedural, moving inside their (possibly exploded) group.
 *    One part's "out" state is its action WEIGHT: 0 blends 100 % back to the saved rest pose,
 *    1 is the full baked offset at the current scrub time. A group's clip is weighted 1 only
 *    while at least one of its papillary is still out — otherwise the last-assembled muscle
 *    would land at the group's exploded offset instead of its true home.
 *  - The loader renames objects on name collision (node `aortic_valve` + mesh `aortic_valve`
 *    -> the mesh becomes `aortic_valve_1`), so the registry's short name can land on the parent
 *    NODE, not the mesh. Part matching must check both.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const SYS_HUE = { chamber: 0.6, valve: 0.045, support: 0.135, organ: 0.35 };

export class AnatomyModel {
	constructor(group, parts, box) {
		this.group = group;
		this.parts = parts; // Map id -> { mesh, node, spec, home, localOut, mat, outAmount, action? }
		this.byMesh = new Map([...parts.values()].map((p) => [p.mesh.uuid, p]));
		this.box = box;
		this.explodeGain = 0.55;
		this.factor = 0;
		this.mixer = null; // built in _bindClips(); drives every baked explode clip
		this.clipDuration = 0; // all clips share one length; scrub time is a fraction of this
		this.groupActions = []; // [{ node, action, members }] for the papillary bundle nodes
	}

	static async load({ url, registry }) {
		const loader = new GLTFLoader();
		loader.setMeshoptDecoder(MeshoptDecoder);
		const gltf = await loader.loadAsync(url);
		const root = gltf.scene;
		root.updateMatrixWorld(true);

		const byMeshName = new Map(registry.parts.map((p) => [p.mesh, p]));
		const meshes = [];
		root.traverse((n) => {
			if (n.isMesh) meshes.push(n);
		});

		const parts = new Map();
		let i = 0;
		const inv = new THREE.Matrix4();
		const bb = new THREE.Box3();
		for (const mesh of meshes) {
			// The registry's short name may sit on the MESH (papillary) or on the parent NODE
			// (leaf parts: the loader demoted the same-named mesh to `<name>_1`).
			let spec = byMeshName.get(mesh.name);
			let node = mesh;
			if (!spec && mesh.parent && byMeshName.has(mesh.parent.name)) {
				spec = byMeshName.get(mesh.parent.name);
				node = mesh.parent;
			}
			if (!spec) continue; // registry-driven: unknown meshes stay inert
			mesh.material = mesh.material.clone();
			mesh.material.color.setHSL(
				SYS_HUE[spec.system] + (i++ % 5) * 0.032,
				0.6,
				0.55,
			);
			mesh.material.roughness = 0.55;
			mesh.material.transparent = false;
			mesh.material.opacity = 1;
			mesh.userData.partId = spec.id;

			inv.copy(mesh.parent.matrixWorld).invert();
			const a = new THREE.Vector3(0, 0, 0).applyMatrix4(inv);
			const b = new THREE.Vector3(spec.out[0], spec.out[1], spec.out[2]).applyMatrix4(inv);

			// A node's origin is NOT its geometry's centre in this asset, so measure the real one
			// once and keep it in mesh space (the mesh only ever translates, never rotates).
			bb.setFromObject(mesh);
			const centerLocal = mesh.worldToLocal(bb.getCenter(new THREE.Vector3()));

			parts.set(spec.id, {
				id: spec.id,
				mesh,
				node, // what actually explodes (the mesh itself for the papillary)
				spec,
				home: mesh.position.clone(),
				// Captured for every part up front rather than lazily on first grab: a reset has
				// to restore a pose it was never told was going to change.
				homeQuat: mesh.quaternion.clone(),
				centerLocal,
				localOut: b.sub(a), // keeps the parent's scale; do not normalise
				mat: mesh.material,
				baseColor: mesh.material.color.clone(),
				outAmount: 1, // per-part 0..1 so one part can snap home while others stay out
			});
		}

		const box = new THREE.Box3().setFromObject(root);
		const model = new AnatomyModel(root, parts, box);
		model._bindClips(gltf.animations);
		return model;
	}

	/**
	 * Wire the baked explode clips into the mixer.
	 *
	 * Each clip targets exactly one node: either a leaf part's anchor node (9) or a papillary
	 * bundle node (2). Node identity comes from the binding's resolved node — NOT the clip
	 * name (GLTFLoader sanitizes names: dots dropped, `_1` demotions, so string matching lies).
	 *
	 * Actions stay permanently active and are scrubbed by mixer.setTime() in apply(): at weight
	 * 0 the PropertyMixer blends 100 % to the saved original (rest) state, which is what makes
	 * assemble() a true snap-home. LoopOnce + clampWhenFinished keep a scrub past the end safe.
	 */
	_bindClips(animations) {
		if (!animations.length) return;
		this.mixer = new THREE.AnimationMixer(this.group);
		this.clipDuration = Math.max(...animations.map((c) => c.duration));
		for (const clip of animations) {
			const action = this.mixer.clipAction(clip);
			action.setLoop(THREE.LoopOnce, 1);
			action.clampWhenFinished = true;
			action.play();
			// three r16x keeps the resolved bindings private (`_propertyBindings`), but
			// play() -> mixer._activateAction() -> _bindAction() fills them synchronously.
			// binding.NODE is the clip's resolved target node (set by findNode at
			// construction); binding.rootNode is the mixer root — NOT the target.
			// Fallback: track-name path (single-segment names in this GLB).
			const pb = action._propertyBindings;
			const node = (pb && pb[0] && pb[0].binding && pb[0].binding.node) ||
				(clip.tracks[0] && this.group.getObjectByName(clip.tracks[0].name.split('.')[0]));
			if (!node) continue;
			let claimed = false;
			for (const p of this.parts.values()) {
				if (p.node === node) {
					p.action = action;
					claimed = true;
				}
			}
			if (!claimed) {
				// A bundle node: the clip targets a group whose meshes are the parts inside it.
				const isDescendant = (obj, anc) => {
					let n = obj.parent;
					while (n) { if (n === anc) return true; n = n.parent; }
					return false;
				};
				const members = [...this.parts.values()].filter((p) => isDescendant(p.mesh, node));
				if (members.length) this.groupActions.push({ node, action, members });
			}
		}
	}

	/** Place the model on a tabletop relative to the player, so it works seated and standing.
	 *  Key names come from the lesson JSON, so a teacher can retune them without touching code. */
	place({ modelScale, distanceMetres, heightAboveFloorMetres }) {
		const c = this.box.getCenter(new THREE.Vector3());
		const s = modelScale;
		this.group.scale.setScalar(s);
		this.group.position.set(
			-c.x * s,
			-c.y * s + heightAboveFloorMetres,
			-distanceMetres - c.z * s,
		);
		return this;
	}

	/** World-space centre of the parts. NOT the group origin: this GLB's geometry sits far above
	 *  its node origin, and scaling multiplies that offset, so the group position is a useless
	 *  anchor for labels — labels anchored to it landed a metre below the heart. */
	centre(target = new THREE.Vector3()) {
		target.set(0, 0, 0);
		let n = 0;
		for (const p of this.parts.values()) {
			target.add(p.mesh.localToWorld(p.centerLocal.clone()));
			n += 1;
		}
		if (n) target.multiplyScalar(1 / n);
		return target;
	}

	/**
	 * Angular footprint of the whole cloud as seen from a point (radians).
	 * az: negative = left of the student's view axis. el: negative = below the eye line.
	 *
	 * This is measured per part from the eye, not as a ring around the model centre: a part
	 * 0.55 m from the face covers more degrees than the same part at 0.85 m, and that is the
	 * only thing that decides whether a reading card sits BESIDE the anatomy or ON TOP of it.
	 * Spacing computed around the model centre collapsed to ~1 degree of real gap under
	 * perspective, which is how the label-blob bug got past a numeric check.
	 */
	angularExtents(eye = new THREE.Vector3()) {
		const o = { azMin: Infinity, azMax: -Infinity, elMin: Infinity, elMax: -Infinity };
		for (const p of this.parts.values()) {
			const c = p.mesh.localToWorld(p.centerLocal.clone()).sub(eye);
			const planar = Math.hypot(c.x, c.z);
			if (planar < 1e-4) continue;
			const r = Math.max(...p.spec.size) * 0.5 * this.group.scale.x;
			const az = Math.atan2(c.x, -c.z);
			const el = Math.atan2(c.y, planar);
			const half = Math.atan2(r, Math.hypot(planar, c.y));
			o.azMin = Math.min(o.azMin, az - half);
			o.azMax = Math.max(o.azMax, az + half);
			o.elMin = Math.min(o.elMin, el - half);
			o.elMax = Math.max(o.elMax, el + half);
		}
		if (!Number.isFinite(o.azMin)) return { azMin: -0.2, azMax: 0.2, elMin: -0.3, elMax: 0.3 };
		return o;
	}

	/**
	 * Every visual state is a function of { factor, per-part outAmount, per-part look };
	 * recompute wholesale, nothing accumulates.
	 *
	 * Hybrid explode: the 9 leaf parts and the 2 papillary groups ride baked clips. A part's
	 * outAmount becomes its action WEIGHT — 0 blends 100 % back to the saved rest pose (which
	 * is why assemble() snaps home exactly), 1 is the full baked offset at the scrub time —
	 * and the shared factor scrubs the clips' time. The clips carry the artist's eased per-part
	 * offsets, so the procedural spread math below only runs for the 5 papillary muscles, which
	 * have no clips of their own (they move inside their group's, possibly exploded, frame).
	 */
	apply() {
		const f = THREE.MathUtils.clamp(this.factor, 0, 1);
		for (const p of this.parts.values()) {
			if (!p.action) continue;
			p.action.enabled = !p.held;
			p.action.setEffectiveWeight(p.outAmount);
		}
		// A group's clip is a no-op once every muscle in it is home — otherwise the last
		// assembled papillary would land at the group's exploded offset, not its true seat.
		for (const g of this.groupActions) {
			const anyOut = g.members.some((m) => m.outAmount > 0);
			g.action.setEffectiveWeight(anyOut ? 1 : 0);
		}
		if (this.mixer) {
			// A LoopOnce action that ever reached the clip end gets PAUSED (clampWhenFinished),
			// and a paused action zero-scales its delta — every later setTime would then read
			// t=0 and the parts would collapse to rest while the factor says "out". Unpause
			// before each scrub; time is always set explicitly below, so real-time advance is
			// never mixed in.
			for (const p of this.parts.values()) if (p.action) p.action.paused = false;
			for (const g of this.groupActions) g.action.paused = false;
			// explodeGain 1 + factor 1 scrubs to clipDuration, which is the last baked keyframe
			// (all 11 clips end at t=2.5 with a key on that frame). A gain below 1 used to stop
			// the playhead early (~27% of the clip) so the tail frames never ran.
			this.mixer.setTime(Math.min(f * this.explodeGain, 1) * this.clipDuration);
		}
		for (const p of this.parts.values()) {
			// While the controller owns a part, it owns the mesh pose outright — otherwise an
			// explode tween running during a grab would drag the part out of the hand.
			if (p.held) continue;
			if (p.action) {
				// Mixer writes the NODE; mesh offset is the student's grab displacement.
				p.mesh.position.copy(p.home);
				if (p.moved) p.mesh.position.add(p.moved);
			} else {
				const k = f * p.outAmount * this.explodeGain;
				p.mesh.position.copy(p.home).addScaledVector(p.localOut, p.spec.spread * k);
				if (p.moved) p.mesh.position.add(p.moved);
			}
			if (!p.turned && p.homeQuat) p.mesh.quaternion.copy(p.homeQuat);
		}
	}

	/** Where a part's mesh sits for the current explode, before any manual displacement. */
	basePos(p, target) {
		if (p.action) return target.copy(p.home);
		const f = THREE.MathUtils.clamp(this.factor, 0, 1) * p.outAmount;
		return target.copy(p.home).addScaledVector(p.localOut, p.spec.spread * f * this.explodeGain);
	}

	/**
	 * Take hold of a part. Returns its current world pose so the caller can record the
	 * offset to the hand and move it from where it already is: snapping the part's origin
	 * onto the controller would make every grab jump.
	 */
	beginGrab(id) {
		const p = this.parts.get(id);
		if (!p) return null;
		p.held = true;
		p.snapFrom = null;
		p.snapWait = 0;
		if (p.action) p.action.enabled = false;
		return {
			pos: p.mesh.getWorldPosition(new THREE.Vector3()),
			quat: p.mesh.getWorldQuaternion(new THREE.Quaternion()),
		};
	}

	/**
	 * Drive a held part to a world pose. Convert through the mesh's OWN parent, not the
	 * model group: quantized glTF puts scale on ancestor nodes.
	 */
	setGrabWorld(id, worldPos, worldQuat) {
		const p = this.parts.get(id);
		if (!p || !p.held) return false;
		const parent = p.mesh.parent;
		const local = parent.worldToLocal(worldPos.clone());
		p.mesh.position.copy(local);
		p.moved = local.clone().sub(this.basePos(p, new THREE.Vector3()));
		if (worldQuat) {
			const inv = parent.getWorldQuaternion(new THREE.Quaternion()).invert();
			p.mesh.quaternion.copy(inv.multiply(worldQuat));
			p.turned = true;
		}
		return true;
	}

	endGrab(id) {
		const p = this.parts.get(id);
		if (!p) return false;
		p.held = false;
		if (p.action) p.action.enabled = true;
		return true;
	}

	/**
	 * Send every part back to its authored pose. Unconditional: a classroom reset between
	 * students has to be exact whether or not the grab bookkeeping kept up.
	 */
	returnMoved() {
		let n = 0;
		for (const p of this.parts.values()) {
			if (p.moved || p.turned || p.held) n += 1;
			p.moved = null;
			p.turned = false;
			p.held = false;
			p.snapFrom = null;
			p.snapWait = 0;
			if (p.action) p.action.enabled = true;
			if (p.homeQuat) p.mesh.quaternion.copy(p.homeQuat);
		}
		this.apply();
		return n;
	}

	/** After a grab on step 5: wait, then ease the part home. */
	scheduleSnap(id, wait = 5, dur = 1.8) {
		const p = this.parts.get(id);
		if (!p) return false;
		p.snapWait = wait;
		p.snapDur = dur;
		p.snapT = 0;
		p.snapFrom = (p.moved || new THREE.Vector3()).clone();
		p.snapFromQuat = p.mesh.quaternion.clone();
		return true;
	}

	tickSnaps(dt) {
		let dirty = false;
		for (const p of this.parts.values()) {
			if (p.held || !p.snapFrom) continue;
			if (p.snapWait > 0) {
				p.snapWait -= dt;
				continue;
			}
			p.snapT += dt;
			const k = Math.min(1, p.snapT / (p.snapDur || 1.8));
			const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
			p.moved = p.snapFrom.clone().multiplyScalar(1 - e);
			if (p.homeQuat && p.snapFromQuat) p.mesh.quaternion.slerpQuaternions(p.snapFromQuat, p.homeQuat, e);
			p.turned = true;
			dirty = true;
			if (k >= 1) {
				p.moved = null;
				p.turned = false;
				p.snapFrom = null;
				if (p.homeQuat) p.mesh.quaternion.copy(p.homeQuat);
			}
		}
		if (dirty) this.apply();
	}

	setFactor(f) {
		this.factor = f;
		this.apply();
		return this;
	}

	/** All parts fully exploded (the retrieval task starts scattered). */
	scatter() {
		for (const p of this.parts.values()) p.outAmount = 1;
		this.apply();
	}

	/** Snap a single part back into place (the reassembly retrieval step). */
	assemble(id) {
		const p = this.parts.get(id);
		if (!p) return false;
		p.outAmount = 0;
		this.apply();
		return true;
	}

	assembledCount() {
		return [...this.parts.values()].filter((p) => p.outAmount === 0).length;
	}

	highlight(id, on) {
		const p = this.parts.get(id);
		if (!p) return;
		p.mat.emissive.setHex(on ? 0x1d3f66 : 0x000000);
	}

	/** Green/red answer feedback without changing the anatomical colour. */
	flash(id, colorHex) {
		const p = this.parts.get(id);
		if (!p) return;
		p.mat.emissive.setHex(colorHex);
		setTimeout(() => this.highlight(id, false), 700);
	}

	/** Show only `ids`; everything else becomes a faint silhouette (keeps spatial context). */
	isolate(ids, contextOpacity = 0.07) {
		const keep = new Set(ids);
		for (const [id, p] of this.parts) {
			const on = keep.has(id);
				p.mat.transparent = !on;
				p.mat.opacity = on ? 1 : contextOpacity;
				p.mat.depthWrite = on;
		}
	}

	ghost(ids, opacity = 0.18) {
		for (const id of ids) {
			const p = this.parts.get(id);
			if (p) {
				p.mat.transparent = true;
				p.mat.opacity = opacity;
				p.mat.depthWrite = false;
			}
		}
	}

	clearLook() {
		for (const p of this.parts.values()) {
			p.mat.transparent = false;
			p.mat.opacity = 1;
			p.mat.depthWrite = true;
			p.mat.emissive.setHex(0x000000);
		}
	}

	/** Step 4: every part is solid. Ghosting leftover from isolate/reveal would stay see-through. */
	forceOpaque() {
		this.clearLook();
	}

	/**
	 * Raycast helper for the controller. Small parts (the 12 mm papillary muscles) get an
	 * enlarged invisible sphere so a student is tested on anatomy, not on aim.
	 */
	hitList(raycaster, { hitSphereMinMetres = 0.025, only } = {}) {
		const meshes = [];
		const spheres = [];
		const sv = new THREE.Vector3();
		for (const [id, p] of this.parts) {
			if (only && !only.has(id)) continue;
			meshes.push(p.mesh);
			// A part is fiddly to point at when it is small OR thin: valves are ring-shaped, so a
			// ray through the middle of the geometry passes through the hole between leaflets.
			const dims = p.spec.size.map((v) => v * this.group.scale.x).sort((a, b) => a - b);
			// A ring is not a solid. A valve's bounding box measures 25-46 mm and so reads "big
			// enough", yet most of that box is the hole — and the hole is exactly where a student
			// aims when asked to point at the valve. Hollow parts always get an aim aid. The flag
			// comes from the registry's own system tag, so it stays data-driven.
			const hollow = p.spec.system === 'valve';
			const needsAid = hollow || dims[0] * 2 < hitSphereMinMetres * 2 || dims[2] < hitSphereMinMetres;
			if (needsAid) {
				if (!p.hit) {
					const s = new THREE.Mesh(
						new THREE.SphereGeometry(1, 10, 8),
						new THREE.MeshBasicMaterial({ visible: false }),
					);
					// Quantized glTF carries scale on ancestor nodes, so divide by the mesh's real
					// world scale — not the group's — or the aid ends up a fraction of a millimetre.
					const ws = p.mesh.getWorldScale(sv).x || 1;
					s.scale.setScalar(hitSphereMinMetres / ws);
					s.position.copy(p.centerLocal);
					p.mesh.add(s);
					p.hit = s;
				}
				p.hit.visible = true;
				spheres.push(p.hit);
			} else if (p.hit) {
				p.hit.visible = false;
			}
		}
		return raycaster.intersectObjects(meshes.concat(spheres), false);
	}

	/** Which part a raycast hit belongs to — the mesh itself or one of its invisible aim aids. */
	idOfHit(hit) {
		if (!hit) return null;
		if (hit.object.userData.partId) return hit.object.userData.partId;
		for (const [id, p] of this.parts) if (p.hit === hit.object) return id;
		return null;
	}

	/** Nearest part the ray touches. This is what a controller trigger selects. */
	pick(raycaster, opts) {
		return this.idOfHit(this.hitList(raycaster, opts)[0]);
	}

	/**
	 * Every part the ray passes through, nearest first. Used to find what is standing between the
	 * student and the part they were asked for, so the UI can get out of the way instead of leaving
	 * the student poking a wall.
	 */
	pickAll(raycaster, opts) {
		const seen = [];
		for (const h of this.hitList(raycaster, opts)) {
			const id = this.idOfHit(h);
			if (id && !seen.includes(id)) seen.push(id);
		}
		return seen;
	}

	/** World-space centre of a part's geometry, for labels, waypoints and task anchors. */
	center(id) {
		const p = this.parts.get(id);
		return p ? p.mesh.localToWorld(p.centerLocal.clone()) : new THREE.Vector3();
	}

	radius(id) {
		const p = this.parts.get(id);
		if (!p) return 0;
		return Math.max(...p.spec.size) * 0.5 * this.group.scale.x;
	}

	stats() {
		return {
			parts: this.parts.size,
			ids: [...this.parts.keys()],
			materials: new Set([...this.parts.values()].map((p) => p.mat.uuid)).size,
			factor: this.factor,
			explodeGain: this.explodeGain,
			clipDuration: this.clipDuration,
			mixerTime: this.mixer ? this.mixer.time : 0,
		};
	}
}
