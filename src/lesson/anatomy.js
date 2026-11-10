/**
 * Anatomy model: loads the optimized HRA heart, joins it to the generated geometry registry,
 * and exposes the teaching verbs (explode / isolate / ghost / highlight / assemble-one-part).
 *
 * Two non-obvious rules baked in here:
 *  - Do NOT flatten the glTF. KHR_mesh_quantization carries dequantization scale on ancestor
 *    nodes; reparenting meshes and resetting TRS inflates them ~10x and collapses the model.
 *  - HRA ships ONE material shared by all parts, so per-part colour/highlight needs a clone.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const SYS_HUE = { chamber: 0.6, valve: 0.045, support: 0.135, organ: 0.35 };

export class AnatomyModel {
	constructor(group, parts, box) {
		this.group = group;
		this.parts = parts; // Map id -> { mesh, spec, home, localOut, mat, assembled }
		this.byMesh = new Map([...parts.values()].map((p) => [p.mesh.uuid, p]));
		this.box = box;
		this.explodeGain = 0.55;
		this.factor = 0;
	}

	static async load({ url, registry, colour = 'texture' }) {
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
			const spec = byMeshName.get(mesh.name);
			if (!spec) continue; // registry-driven: unknown meshes stay inert
			// A model with painted PBR maps keeps them. The per-part colour and the flat 0.55
			// roughness were written for the untextured reference mesh, where they are the ONLY
			// surface information; on a textured model the colour multiplies over the base map
			// and the roughness factor scales the roughness map, washing the painting out.
			// `colour: 'system'` brings the body-system tint back on top of the texture, for when
			// the colour code matters more than the painting.
			const textured = !!mesh.material.map;
			mesh.material = mesh.material.clone();
			if (!textured || colour === 'system')
				mesh.material.color.setHSL(SYS_HUE[spec.system] + (i++ % 5) * 0.032, 0.6, textured ? 0.75 : 0.55);
			if (!textured) mesh.material.roughness = 0.55;
			mesh.material.transparent = true; // needed for ghosting; opacity stays 1
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
				spec,
				home: mesh.position.clone(),
				// Captured for every part up front rather than lazily on first grab: a reset has
				// to be able to restore a pose it was never told was going to change.
				homeQuat: mesh.quaternion.clone(),
				centerLocal,
				localOut: b.sub(a), // keeps the parent's scale; do not normalise
				mat: mesh.material,
				baseColor: mesh.material.color.clone(),
				outAmount: 1, // per-part 0..1 so one part can snap home while others stay out
			});
		}

		const box = new THREE.Box3().setFromObject(root);
		return new AnatomyModel(root, parts, box);
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

	/** One scalar drives every part; per-part `outAmount` lets the reassembly task snap parts in. */
	apply() {
		for (const p of this.parts.values()) {
			// F4: while the controller owns a part, it owns its position outright - otherwise an
			// explode tween running during a grab would drag the part out of the student's hand.
			if (p.held) continue;
			this.basePos(p, p.mesh.position);
			// A part the student moved aside keeps that displacement through later explodes, so
			// "get it out of the way" stays true instead of being undone by the next step's tween.
			if (p.moved) p.mesh.position.add(p.moved);
		}
	}

	/** Where a part sits for the current explode factor, before any manual displacement. */
	basePos(p, target) {
		const f = this.factor * p.outAmount;
		return target.copy(p.home).addScaledVector(p.localOut, p.spec.spread * f * this.explodeGain);
	}

	/**
	 * Take hold of a part. Returns its current world position so the caller can record the
	 * offset to the hand and move it from where it already is: snapping the part's origin onto
	 * the controller would make every grab jump, which reads as grabbing the wrong thing.
	 */
	beginGrab(id) {
		const p = this.parts.get(id);
		if (!p) return null;
		// Grabbing a part mid-flight takes it from wherever it has got to, rather than
		// snapping it home first.
		this.cancelHoming(id);
		p.held = true;
		return {
			pos: p.mesh.getWorldPosition(new THREE.Vector3()),
			quat: p.mesh.getWorldQuaternion(new THREE.Quaternion()),
		};
	}

	/**
	 * Drive a held part to a world pose. `worldQuat` is optional: translation-only grabs keep
	 * the authored orientation, which matters because a rotated organ can be read as different
	 * anatomy rather than the same part turned round.
	 */
	setGrabWorld(id, worldPos, worldQuat) {
		const p = this.parts.get(id);
		if (!p || !p.held) return false;
		// Convert through the mesh's OWN parent, not the model group: quantized glTF puts scale
		// on ancestor nodes, so the group is not necessarily the direct parent.
		const parent = p.mesh.parent;
		const local = parent.worldToLocal(worldPos.clone());
		p.mesh.position.copy(local);
		p.moved = local.clone().sub(this.basePos(p, new THREE.Vector3()));
		if (worldQuat) {
			// World orientation back into the parent's space, or an ancestor's own rotation
			// would be applied twice.
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
		return true;
	}

	/**
	 * Send hand-moved and hand-turned parts home over `dur` seconds instead of teleporting.
	 *
	 * Used on a step change. A part the student pulled out and spun in step 2 used to jump
	 * home in a single frame on Continue, which reads as the model glitching rather than the
	 * lesson putting it back. Full Reset still uses the instant returnMoved(): between two
	 * students, exactness beats animation.
	 */
	homeMoved(dur = 0.8) {
		this.homing = [];
		for (const [id, p] of this.parts) {
			p.held = false;
			if (!p.moved && !p.turned) continue;
			this.homing.push({
				id,
				p,
				moved0: p.moved ? p.moved.clone() : null,
				quat0: p.mesh.quaternion.clone(),
			});
		}
		this.homingT = 0;
		this.homingDur = dur;
		if (!this.homing.length) this.homing = null;
		this.apply();
		return this.homing ? this.homing.length : 0;
	}

	/** Advance a homing in progress. Lands EXACTLY on the authored pose. */
	stepHoming(dt) {
		if (!this.homing) return false;
		this.homingT += dt;
		const k = Math.min(1, this.homingT / this.homingDur);
		// Ease-out: moves at once and settles gently - an ease-in looked like nothing happened.
		const e = 1 - (1 - k) ** 3;
		for (const h of this.homing) {
			const p = h.p;
			if (k >= 1) {
				// Finish on the stored authored values, not on an interpolated float, so the
				// part ends bit-identical to where it started the lesson.
				p.moved = null;
				p.turned = false;
				p.mesh.quaternion.copy(p.homeQuat);
				continue;
			}
			if (h.moved0) (p.moved ||= new THREE.Vector3()).copy(h.moved0).multiplyScalar(1 - e);
			p.mesh.quaternion.slerpQuaternions(h.quat0, p.homeQuat, e);
		}
		if (k >= 1) this.homing = null;
		this.apply();
		return true;
	}

	/** Drop one part out of a homing in progress, leaving it where it currently is. */
	cancelHoming(id) {
		if (!this.homing) return;
		this.homing = this.homing.filter((h) => h.id !== id);
		if (!this.homing.length) this.homing = null;
	}

	/** Ids the student has displaced or turned by hand. */
	movedIds() {
		return [...this.parts].filter(([, p]) => p.moved || p.turned).map(([id]) => id);
	}

	/**
	 * Send every part back to its authored pose.
	 *
	 * Written to be unconditional rather than to undo the specific things it knows about. The
	 * flags (`moved`, `turned`, `held`) are an optimisation for apply(), not a trustworthy
	 * record of what a student managed to disturb, and a reset between two students has to be
	 * exact whether or not the bookkeeping kept up. Clearing and restoring every part costs
	 * one pass over 14 objects.
	 */
	returnMoved() {
		// The instant path wins over any smooth homing in flight.
		this.homing = null;
		let n = 0;
		for (const p of this.parts.values()) {
			if (p.moved || p.turned || p.held) n += 1;
			p.moved = null;
			p.turned = false;
			p.held = false;
			// Rotation is restored for every part, not just flagged ones: centerLocal, the hit
			// aids and the leader-line anchors are all measured in mesh space on the assumption
			// that a part's orientation is the authored one.
			if (p.homeQuat) p.mesh.quaternion.copy(p.homeQuat);
		}
		this.apply();
		return n;
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
	flash(id, colorHex, blinks = 1) {
		const p = this.parts.get(id);
		if (!p) return;
		// Defect #2: colour alone cannot carry correctness. Red-green colour vision deficiency
		// runs ~8% in boys, and a green flash versus a red one is exactly the comparison those
		// students cannot make. The BLINK COUNT now carries the same meaning: one held pulse
		// means right, two quick pulses mean wrong, which reads identically to every student.
		this._flashTimers = this._flashTimers || new Map();
		// A new flash on the same part must cancel the old one's timers, or a stray callback
		// clears the emissive mid-pattern and the blink count stops being countable.
		(this._flashTimers.get(id) || []).forEach(clearTimeout);
		const timers = [];
		const on = 150;
		const gap = 120;
		for (let i = 0; i < blinks; i++) {
			const t0 = i * (on + gap);
			timers.push(setTimeout(() => p.mat.emissive.setHex(colorHex), t0));
			// Hold the last pulse longer so a single blink still reads as a deliberate confirm
			// rather than a glitch.
			const hold = i === blinks - 1 && blinks === 1 ? 550 : on;
			timers.push(setTimeout(() => this.highlight(id, false), t0 + hold));
		}
		this._flashTimers.set(id, timers);
	}

	/** Show only `ids`; everything else becomes a faint silhouette (keeps spatial context). */
	isolate(ids, contextOpacity = 0.07) {
		const keep = new Set(ids);
		for (const [id, p] of this.parts) {
			const on = keep.has(id);
			p.mat.opacity = on ? 1 : contextOpacity;
			p.mat.depthWrite = on;
		}
	}

	ghost(ids, opacity = 0.18) {
		for (const id of ids) {
			const p = this.parts.get(id);
			if (p) {
				p.mat.opacity = opacity;
				p.mat.depthWrite = false;
			}
		}
	}

	clearLook() {
		for (const p of this.parts.values()) {
			p.mat.opacity = 1;
			p.mat.depthWrite = true;
			p.mat.emissive.setHex(0x000000);
		}
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
		};
	}
}
