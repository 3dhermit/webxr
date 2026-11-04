/**
 * In-world text. Quest Browser does not support DOM overlay in immersive-vr, so every word a
 * student reads has to be geometry. troika renders SDF text as a single mesh, which is cheap
 * enough to have several panels on screen and still stay inside a 100 draw-call budget.
 */
import * as THREE from 'three';
import { Text } from 'troika-three-text';

export const FONT = 'assets/SpaceMono-Bold.ttf';

/** A wrapped text mesh with a legibility outline (it sits over anatomy, not over a flat page). */
export function makeText({
	fontSize = 0.022,
	maxWidth = 0.5,
	color = 0xf2f2f2,
	align = 'left',
	anchorX = 'left',
	anchorY = 'top',
} = {}) {
	const t = new Text();
	t.font = FONT;
	t.fontSize = fontSize;
	t.maxWidth = maxWidth;
	t.textAlign = align;
	t.anchorX = anchorX;
	t.anchorY = anchorY;
	t.color = color;
	// Outline keeps letters readable where a bright mesh passes behind the panel.
	t.outlineWidth = fontSize * 0.09;
	t.outlineColor = 0x000000;
	t.outlineOpacity = 0.75;
	t.letterSpacing = 0.02;
	return t;
}

/** Text plus a backdrop sized to the text. Call set() then sync(); the panel follows. */
export class Panel {
	constructor({ width = 0.56, fontSize = 0.022, padding = 0.018 } = {}) {
		this.group = new THREE.Group();
		this.padding = padding;
		this.text = makeText({ fontSize, maxWidth: width - padding * 2 });
		this.back = new THREE.Mesh(
			new THREE.PlaneGeometry(width, 0.1),
			new THREE.MeshBasicMaterial({
				color: 0x101418,
				transparent: true,
				opacity: 0.82,
				depthWrite: false,
			}),
		);
		this.back.position.z = -0.002;
		this.group.add(this.back, this.text);
		this.text.position.set(-width / 2 + padding, 0, 0);
		this.text.anchorX = 'left';
		this.text.anchorY = 'top';
		this.width = width;
	}

	set(text, color) {
		this.text.text = text || '';
		if (color !== undefined) this.text.color = color;
		this.text.sync();
		this.fit();
		return this;
	}

	/** Size the backdrop from troika's measured dimensions once the text has synced. */
	fit() {
		const d = this.text.textDimensions || { width: this.width, height: 0.04 };
		const w = this.width;
		const h = d.height + this.padding * 2;
		this.back.scale.set(w / this.back.geometry.parameters.width, h / this.back.geometry.parameters.height, 1);
		this.back.position.y = -h / 2 + this.padding;
		this.height = h;
		return this;
	}
}

/**
 * A part-name label. The text sits at the group's own origin on purpose: the group is billboarded
 * each frame, and a group rotated about a distant origin would swing its text across the scene.
 * The leader line lives outside this group (in a non-rotating group) for the same reason.
 */
export function makeLabel(fontSize = 0.014, color = 0xffffff) {
	const g = new THREE.Group();
	const text = makeText({ fontSize, maxWidth: 0.16, anchorX: 'center', anchorY: 'middle', align: 'center', color });
	g.add(text);
	g.userData.text = text;
	return g;
}

export function makeLeaderLine() {
	return new THREE.Line(
		new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
		new THREE.LineBasicMaterial({ color: 0xbfd4e6, transparent: true, opacity: 0.8 }),
	);
}

/** Repoint a leader line in world space: from the part surface out to its label. */
export function updateLeaderLine(line, fromWorld, toWorld) {
	const attr = line.geometry.attributes.position;
	attr.setXYZ(0, fromWorld.x, fromWorld.y, fromWorld.z);
	attr.setXYZ(1, toWorld.x, toWorld.y, toWorld.z);
	attr.needsUpdate = true;
	line.geometry.computeBoundingSphere();
}

/** 3D button: a plate plus a caption. Returns an Object3D whose userData.onClick we wire up. */
export function makeButton({ label, width = 0.2, height = 0.055, fontSize = 0.02 }) {
	const g = new THREE.Group();
	const plate = new THREE.Mesh(
		new THREE.PlaneGeometry(width, height),
		new THREE.MeshStandardMaterial({ color: 0x2f6fb3, roughness: 0.6 }),
	);
	const caption = makeText({ fontSize, maxWidth: width, anchorX: 'center', anchorY: 'middle', align: 'center' });
	caption.text = label;
	caption.sync();
	g.add(plate, caption);
	g.userData.plate = plate;
	g.userData.caption = caption;
	return g;
}
