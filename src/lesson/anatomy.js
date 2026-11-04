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
			const spec = byMeshName.get(mesh.name);
			if (!spec) continue; // registry-driven: unknown meshes stay inert
			mesh.material = mesh.material.clone();
			mesh.material.color.setHSL(
				SYS_HUE[spec.system] + (i++ % 5) * 0.032,
				0.6,
				0.55,
			);
			mesh.material.roughness = 0.55;
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
			const f = this.factor * p.outAmount;
			p.mesh.position.copy(p.home).addScaledVector(p.localOut, p.spec.spread * f * this.explodeGain);
		}
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
