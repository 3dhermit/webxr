/**
 * In-world text. Quest Browser does not support DOM overlay in immersive-vr, so every word a
 * student reads has to be geometry. troika renders SDF text as a single mesh, which is cheap
 * enough to have several panels on screen and still stay inside a 100 draw-call budget.
 */
import * as THREE from 'three';
import { Text } from 'troika-three-text';

export const FONT = 'assets/SpaceMono-Bold.ttf';

/**
 * Read the block size troika measured for a Text.
 *
 * troika 0.49.1 has NO public `textDimensions` property — the measurements live on the private
 * `_textRenderInfo` (see its TypesetResult: blockBounds = [minX, minY, maxX, maxY], valid only
 * after sync() completes). Code that reads `text.textDimensions` silently gets `undefined`, and a
 * panel sized from that falls back to a fixed height while the text keeps growing: that is the
 * real reason instruction lines spilled over the heart on Firefox. The fallback chain here means a
 * troika upgrade that renames the field degrades to "keep the previous size" instead of collapsing.
 */
export function measureText(t) {
	const ri = t._textRenderInfo || t.textDimensions;
	if (!ri) return null;
	if (Array.isArray(ri.blockBounds)) {
		const [x0, y0, x1, y1] = ri.blockBounds;
		return { width: x1 - x0, height: y1 - y0 };
	}
	if (typeof ri.height === 'number') return { width: ri.width, height: ri.height };
	return null;
}

/** A wrapped text mesh with a legibility outline (it sits over anatomy, not over a flat page). */
export function makeText({
	fontSize = 0.022,
	maxWidth = 0.5,
	color = 0xf2f2f2,
	align = 'left',
	anchorX = 'left',
	anchorY = 'top',
	lineHeight = 1.25,
} = {}) {
	const t = new Text();
	t.font = FONT;
	t.fontSize = fontSize;
	// lineHeight 'normal' means the FONT's own metrics. Space Mono's are ~2.1 em, which turned a
	// 200-character prompt into a 19-line block and made the reading card taller than the heart.
	// Always set it explicitly when the layout budget is in degrees of view.
	t.lineHeight = lineHeight;
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
		this.fit(); // first guess with the previous measurement, so the panel never collapses
		// troika measures wrapped text asynchronously: textDimensions is only valid after the
		// sync completes. Fitting before that sizes the backdrop from the PREVIOUS string, so a
		// longer prompt spills its last lines off the panel and straight over the anatomy.
		this.text.sync(() => {
			this.fit();
			if (this.onfit) this.onfit();
		});
		return this;
	}

	/** Size the backdrop from troika's measured dimensions once the text has synced. */
	fit() {
		const d = measureText(this.text);
		this.measured = !!d;
		// Until the first real measurement lands, keep the last height rather than collapsing the
		// panel to a stub — a collapsing backdrop wipes the previous line's worth of card.
		const h = (d ? d.height : Math.max(0.04, (this.height || 0) - this.padding * 2)) + this.padding * 2;
		const w = this.width;
		this.textHeight = d ? d.height : 0;
		this.textWidth = d ? d.width : 0;
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
	// Generous maxWidth on purpose: a part name must stay on ONE line. With the label font at
	// 0.022 m and a 0.16 m wrap, "Right atrium" broke into three stacked lines and read as a blob
	// of text over the heart. Angular spacing (spreadAngles) handles collisions instead.
	const text = makeText({ fontSize, maxWidth: 1.2, anchorX: 'center', anchorY: 'middle', align: 'center', color });
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
