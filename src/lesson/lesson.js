/**
 * Lesson runtime: reads the lesson JSON and runs it in world space. Every interaction maps to a
 * learning outcome, and every choice the student makes gets an immediate, specific response.
 * Nothing is stored — the classroom rule is formative feedback only, no records, no accounts.
 */
import * as THREE from 'three';

import { Panel, makeButton, makeLabel, makeLeaderLine, makeSkinnedButton, makeText, setButtonLabel, updateLeaderLine } from './text.js';
import { VideoScreen } from './video.js';
import { XR_BUTTONS } from 'gamepad-wrapper';

const OK = 0x8fe3a0;
const BAD = 0xff9a8a;
const MUTED = 0xb9c7d4;

export class Lesson {
	constructor({ player, camera, renderer, model, data, level, debug = false }) {
		this.player = player;
		this.camera = camera;
		this.renderer = renderer;
		this.model = model;
		this.data = data;
		this.level = level || data.defaultLevel || 'hs';
		this.debug = debug;

		this.steps = data.steps;
		this.i = -1;
		this.tweens = [];
		this.root = new THREE.Group();
		this.labelGroup = new THREE.Group();
		// Leader lines stay outside the billboarded label groups: a line rotated with the camera
		// would detach from the part it points at.
		this.lineGroup = new THREE.Group();
		this.waypointGroup = new THREE.Group();
		this.root.add(this.lineGroup, this.labelGroup, this.waypointGroup);
		this.player.add(this.root);

		const u = (data.runtime || {}).ui || {};
		// Authored in DEGREES of view, not metres. A headset student does not see centimetres:
		// the Quest 2 lens puts ~18.5 pixels on every degree, and any card placed in metres
		// silently changes size the moment the model moves closer or further. Degrees are the
		// unit the student actually experiences, so they are the unit the layout is specified in.
		this.uiDeg = {
			side: u.panelSide === 'right' ? 1 : -1,
			width: u.panelAngularWidthDeg ?? 16,
			gap: u.panelGapDeg ?? 5,
			depth: u.panelDepthMetres ?? 0.62,
			bottomElev: u.panelBottomElevDeg ?? -13,
			promptText: u.promptTextDeg ?? 1.45,
			feedText: u.feedbackTextDeg ?? 1.2,
			btnAz: u.buttonAzDeg ?? 30,
			btnElev: u.buttonElevDeg ?? -22,
			btnWidth: u.buttonWidthDeg ?? 13,
			maxAz: u.maxComfortAzDeg ?? 45,
			// F5: Back / Full Reset live opposite the Continue plate so 'go on' and 'go back'
			// are never adjacent targets for a mis-aimed ray.
			navAz: u.navAzDeg ?? -31,
			navTopElev: u.navTopElevDeg ?? -15,
			navGap: u.navGapDeg ?? 9,
			navWidth: u.navWidthDeg ?? 11,
		};
		this.ui = { eyeY: u.eyeHeightMetres ?? 1.45 };
		this.planUi();

		// Named so the in-headset tuner can change plate size/spacing without a rebuild of
		// anything but the UI itself.
		this.quizPlateMul = (data.runtime || {}).ui?.quizPlateMul ?? 2.6;
		this.maxExtraSpread = (data.runtime || {}).maxExtraSpread ?? 1.2;
		this.quizPitchMul = (data.runtime || {}).ui?.quizPitchMul ?? 1.22;

		this.t = new THREE.Vector3();
		this.ray = new THREE.Raycaster();
		this.hover = null;
		// The part the student last pressed, named ON the anatomy rather than only in the
		// feedback card. By the time a student has looked down at a card and back up, which
		// shape they pressed is no longer obvious - especially exploded, with a dozen similar
		// forms in view.
		this.selId = null;
		this.selGroup = new THREE.Group();
		this.selLabel = makeLabel(this.data.runtime?.labelTextHeightMetres ?? 0.014, 0xffffff);
		this.selLine = makeLeaderLine();
		this.selGroup.add(this.selLabel);
		this.selGroup.visible = false;
		this.selLine.visible = false;
		this.root.add(this.selGroup);
		this.root.add(this.selLine);
		// Which controller is driving. Right-hand-first would leave a left-handed student
		// pointing with a dead controller whenever both are tracked.
		this.lastHand = 'right';
		this.flow = { i: 0, misses: 0 };
		this.find = { queue: [], asked: null, misses: 0 };
		this.done = false;

		// F1: interactive callouts. Each entry is a marker dot anchored to a part (it tracks
		// the part through explode/scatter, re-anchored every frame like the waypoints); a
		// trigger on the dot opens a floating text panel, a trigger again — or on any part —
		// closes it. Dots win the hover test over the part they sit on, so the finer target
		// is never shadowed. Unknown anchors are dropped silently so a bad JSON line can't
		// take the whole lesson down.
		this.callouts = [];
		this.calloutDots = [];
		this.calloutGroup = new THREE.Group();
		this.calloutOpen = null;
		this.calloutHover = null;
		this.root.add(this.calloutGroup);
		for (const c of data.callouts ?? []) {
			if (!this.model.parts.get(c.anchor)) continue;
			const marker = new THREE.Group();
			// A callout that plays a clip gets a PLAY TRIANGLE in a warmer colour instead of the
			// round dot. Identical markers left the one launcher in the lesson indistinguishable
			// from the three text callouts, so nothing told a student the footage existed. A
			// three-sided cone reads as a triangle from any angle a student can reach, and shape
			// survives the red-green colour deficiency that colour alone would exclude.
			const isVideo = !!c.video;
			const dot = isVideo
				? new THREE.Mesh(
						new THREE.ConeGeometry(0.011, 0.019, 3),
						new THREE.MeshBasicMaterial({ color: 0xffc14d }),
					)
				: new THREE.Mesh(
						new THREE.SphereGeometry(0.0075, 16, 12),
						new THREE.MeshBasicMaterial({ color: 0x37c8ff }),
					);
			// Point the triangle the way a play glyph does.
			if (isVideo) dot.rotation.z = -Math.PI / 2;
			dot.userData.calloutIndex = this.callouts.length;
			const hover = makeLabel(this.data.runtime?.labelTextHeightMetres ?? 0.014, 0xffffff);
			// makeLabel deliberately never wraps, because a PART NAME must stay on one line.
			// A callout title is a sentence, so without a wrap width it stretches right across
			// the organ it is pointing at - caught in a screenshot, not by any assertion.
			hover.userData.text.maxWidth = this.data.runtime?.calloutLabelWrapMetres ?? 0.22;
			// Lifted well clear of the organ instead of being drawn through it. The marker sits
			// ON the surface of its part, so a tooltip a few millimetres above it is half
			// swallowed by the anatomy - and defeating depth testing is not the fix, because
			// troika re-derives its material on every sync and the flags do not survive.
			hover.position.y = this.data.runtime?.calloutLabelLiftMetres ?? 0.14;
			hover.visible = false;
			marker.add(dot, hover);
			this.calloutGroup.add(marker);
			this.callouts.push({
				spec: c,
				marker,
				dot,
				hover,
				isVideo,
				// Kept per marker so hover can restore the right idle tint for its kind.
				tint: isVideo ? 0xffc14d : 0x37c8ff,
				offset: new THREE.Vector3(...(c.offset ?? [0, 0.05, 0])),
			});
			this.calloutDots.push(dot);
		}

		// F2: the flat video pop-up. Lives in the same space as the camera so it can be placed
		// from the camera's local transform without a world-matrix round trip.
		this.video = new VideoScreen({
			camera: this.camera,
			parent: this.player,
			videos: data.videos || {},
			runtime: (data.runtime || {}).ui || {},
		});
		this.videoFromCallout = null;
		// F4: squeeze-to-grab. Trigger stays 'select/advance'; squeeze is 'move this aside'.
		this.grab = null;
		// Student-driven extra spread, on top of whatever the step authored.
		this.stepFactor = 0;
		this.extraSpread = 0;

		this.buildUI();
	}

	textOf(field) {
		if (!field) return '';
		return typeof field === 'string' ? field : field[this.level] || field.hs || '';
	}

	partName(id) {
		// Lesson-authored display name wins: the asset's own label is an anatomy-ontology string
		// ("heart left ventricle"), which reads wrong on a label a 15-year-old is asked to say.
		const n = (this.data.names || {})[id];
		if (n) return n;
		const p = this.model.parts.get(id);
		return p ? p.spec.label : id;
	}

	/** Plain-language gloss for a part, from the lesson's own vocab list, or a structural note. */
	factFor(id) {
		const hit = (this.data.vocab || []).find((v) => (v.ids || []).includes(id));
		if (hit) return this.textOf(hit.def);
		const p = this.model.parts.get(id);
		return p ? `Part of the ${p.spec.system}.` : '';
	}

	/**
	 * Place the reading card clear of the anatomy, using the anatomy's measured angular width.
	 *
	 * The card used to be hand-placed in metres, and it kept landing on the organ: a 0.28 m card
	 * at 0.34 m covers ~44 degrees of view while the exploded cloud is ~32 degrees wide, so
	 * "off to the left by 0.16 m" still overlapped ~14% of the cloud. Here the cloud is measured
	 * from the student's eye at the widest spread this lesson ever reaches, and the card is put
	 * outside that band with a gap. Head turns of 25-40 degrees are free in a seated lesson;
	 * an instruction card printed over the thing being studied is not.
	 *
	 * Depth sits just in front of the organ so the text does not float out into the room, and
	 * text size is specified in degrees, which converts to a fixed pixel height on the lens
	 * (~18.5 px/deg on Quest 2) regardless of how the model is scaled.
	 */
	planUi() {
		const g = this.uiDeg;
		const rad = (d) => (d * Math.PI) / 180;
		const eye = new THREE.Vector3(0, this.ui.eyeY, 0);

		// Measure at the widest disassembly the lesson actually asks for, not blind maximum, so
		// the card is not pushed further away than the content needs.
		let maxFactor = 0;
		for (const s of this.data.steps || []) {
			const e = s.action?.explode;
			if (Array.isArray(e)) maxFactor = Math.max(maxFactor, ...e);
			else if (typeof e === 'number') maxFactor = Math.max(maxFactor, e);
		}
		const saved = this.model.factor ?? 0;
		this.model.setFactor(maxFactor);
		const a = this.model.angularExtents(eye);
		this.model.setFactor(saved);
		this.cloudAngles = {
			azMin: +((a.azMin * 180) / Math.PI).toFixed(1),
			azMax: +((a.azMax * 180) / Math.PI).toFixed(1),
		};

		const gap = rad(g.gap);
		const w = rad(g.width);
		let side = g.side;
		// If the chosen side would push the card's outer edge past the comfortable view cone,
		// flip it rather than shrink the card into unreadability.
		const edge = (s) => Math.abs((s < 0 ? a.azMin : a.azMax) + s * (gap + w));
		if (edge(side) > rad(g.maxAz)) side = -side;

		const inner = side < 0 ? a.azMin - gap : a.azMax + gap;
		const outer = inner + side * w;
		const p = g.depth;
		// Cards live on a plane at z = -p. On that plane, azimuth maps to x by tan(), which is
		// how a degrees spec becomes a position without a second source of truth.
		const xIn = p * Math.tan(inner);
		const xOut = p * Math.tan(outer);

		// F1: the callout card takes the OTHER side of the anatomy band, measured the same way,
		// so the prompt card and a callout can both be open without either covering the heart.
		const cIn = side < 0 ? a.azMax + gap : a.azMin - gap;
		const cOut = cIn - side * w;
		this.ui.calloutX = (p * Math.tan(cIn) + p * Math.tan(cOut)) / 2;

		this.ui.panelZ = -p;
		this.ui.panelX = (xIn + xOut) / 2;
		this.ui.panelW = Math.abs(xOut - xIn);
		this.ui.promptText = p * Math.tan(rad(g.promptText));
		this.ui.feedText = p * Math.tan(rad(g.feedText));
		// Bottom edge pinned below the eye line; the stack grows UP from here (relayout), so a
		// longer prompt can never extend down across the anatomy.
		this.ui.panelBottom = this.ui.eyeY + p * Math.tan(rad(g.bottomElev));
		this.ui.btnX = p * Math.tan(rad(g.btnAz));
		this.ui.btnY = this.ui.eyeY + p * Math.tan(rad(g.btnElev));
		this.ui.btnW = p * Math.tan(rad(g.btnWidth));
		this.ui.navX = p * Math.tan(rad(g.navAz));
		this.ui.navTopY = this.ui.eyeY + p * Math.tan(rad(g.navTopElev));
		this.ui.navGap = p * Math.tan(rad(g.navGap));
		this.ui.navW = p * Math.tan(rad(g.navWidth));
	}

	buildUI() {
		const { panelW, promptText, feedText, btnW } = this.ui;
		// One panel carries the step counter inside it. A separate floating counter line printed
		// straight through the prompt panel and read as doubled text.
		this.prompt = new Panel({ width: panelW, fontSize: promptText });
		this.feedback = new Panel({ width: panelW, fontSize: feedText });
		// troika measures wrapped text asynchronously, so the measured height arrives after set().
		// Re-anchor the stack each time a panel is remeasured, or the backdrop keeps the previous
		// prompt's height and the extra lines spill off it onto the model.
		this.prompt.onfit = () => this.relayout();
		this.feedback.onfit = () => this.relayout();
		// The plate is sized from the same angular spec as everything else, so it stays the same
		// apparent size on the lens when the card moves closer to or further from the face.
		// Plate is deliberately taller than the old 0.26 ratio: the label is long, and auto-fit
		// would otherwise shrink it to stay on one line inside a very shallow plate.
		this.continueBtn = makeButton({ label: 'Continue  (trigger)', width: btnW, height: btnW * 0.34 });
		this.root.add(this.prompt.group, this.feedback.group, this.continueBtn);

		// Panels face the reader's eye height here, then track the head in update(). The Continue
		// plate sits well off-axis, so a fixed tilt made it read edge-on at the frame edge.
		// F1: one reusable callout card plus a leader line back to the dot that opened it.
		this.calloutPanel = new Panel({ width: panelW, fontSize: feedText });
		this.calloutPanel.onfit = () => this.placeCalloutPanel();
		this.calloutPanel.group.visible = false;
		this.calloutLine = makeLeaderLine();
		this.calloutLine.visible = false;
		this.root.add(this.calloutPanel.group, this.calloutLine);

		// Defect #2: correctness was signalled by COLOUR ALONE — a green card for right, a red
		// card for wrong. With red-green colour vision deficiency at ~8% in boys, one or two
		// students in a class of 28 could not read the single most important signal the lesson
		// produces. Shape is now redundant with hue: a filled disc means right, a cross means
		// wrong. Geometry is used rather than a glyph because the bundled monospace font has no
		// guaranteed coverage for check/cross codepoints.
		const br = this.ui.feedText * 0.52;
		const okMark = new THREE.Mesh(
			new THREE.CircleGeometry(br, 24),
			new THREE.MeshBasicMaterial({ color: OK }),
		);
		const badMark = new THREE.Group();
		// The two bars cross, so they overlap in the middle. Authored at the same z they are
		// coplanar there and fight exactly like a caption on its plate; a fraction of a
		// millimetre apart settles the order.
		[Math.PI / 4, -Math.PI / 4].forEach((rot, k) => {
			const bar = new THREE.Mesh(
				new THREE.PlaneGeometry(br * 2.2, br * 0.5),
				new THREE.MeshBasicMaterial({ color: BAD }),
			);
			bar.rotation.z = rot;
			bar.position.z = k * 0.0004;
			badMark.add(bar);
		});
		okMark.visible = false;
		badMark.visible = false;
		this.badge = new THREE.Group();
		this.badge.add(okMark, badMark);
		this.badge.userData = { ok: okMark, bad: badMark };
		this.badge.visible = false;
		this.root.add(this.badge);

		// Defect #1: heart.json authors four cited quiz questions and NOTHING read them -
		// `npm run validate` even counted them ("quiz 4"), so the gate reported healthy content
		// that reached no student. They are now a real step with four pickable choice plates.
		// F5: image-skinned Back and Full Reset. The skin is painted to a canvas so the buttons
		// work with no art shipped; runtime.ui.backImage / resetImage replace it when art exists.
		const ui = (this.data.runtime || {}).ui || {};
		const navH = this.ui.navW * 0.3;
		this.backBtn = makeSkinnedButton({
			label: 'Back',
			width: this.ui.navW,
			height: navH,
			image: ui.backImage,
			fill: '#2f6fb3',
			edge: '#8ec5ff',
		});
		this.resetBtn = makeSkinnedButton({
			label: 'Full Reset',
			width: this.ui.navW,
			height: navH,
			image: ui.resetImage,
			// Warm skin so it never reads as just another blue 'go' button, backed up by the
			// two-press confirm below - colour alone must not be what protects a student's work.
			fill: '#9a5a1e',
			edge: '#ffc489',
		});
		this.navBtns = { back: this.backBtn, reset: this.resetBtn };
		this.root.add(this.backBtn, this.resetBtn);
		this.navHover = null;
		this.resetArmed = 0;

		this.quizGroup = new THREE.Group();
		this.quizPlates = [];
		const qw = this.ui.panelW * 0.98;
		const qh = this.ui.feedText * this.quizPlateMul;
		for (let i = 0; i < 4; i++) {
			const plate = makeButton({ label: '', width: qw, height: qh, fontSize: this.ui.feedText * 0.92 });
			plate.userData.choice = i;
			this.quizPlates.push(plate);
			this.quizGroup.add(plate);
		}
		this.quizGroup.visible = false;
		this.root.add(this.quizGroup);
		this.quiz = null;

		this.uiParts = [this.prompt.group, this.feedback.group, this.continueBtn, this.calloutPanel.group, this.badge, this.backBtn, this.resetBtn];
		this.applyUiLayout();
		for (const head of this.uiParts) head.lookAt(0, this.ui.eyeY, 0);
	}

	/**
	 * Tear the UI down and rebuild it from the current numbers. Needed only for tuning: a
	 * Panel's backdrop geometry and a troika Text's font size are both fixed at construction,
	 * so a live text-size change cannot be applied in place. Re-enters the current step to
	 * repopulate the cards, which is why this is a tuning path and not a runtime one.
	 */
	rebuildUI() {
		const old = [
			this.prompt?.group,
			this.feedback?.group,
			this.continueBtn,
			this.calloutPanel?.group,
			this.calloutLine,
			this.badge,
			this.quizGroup,
			this.backBtn,
			this.resetBtn,
			this.hoverLine,
		].filter(Boolean);
		for (const o of old) {
			this.root.remove(o);
			o.traverse?.((c) => {
				c.geometry?.dispose?.();
				c.material?.dispose?.();
				if (c !== o) c.dispose?.();
			});
		}
		this.hoverLine = null;
		this.badgeKind = null;
		this.quizHover = null;
		this.buildUI();
		this.enterStep(this.i);
	}

	/**
	 * Push the planned layout onto the objects. Separate from buildUI so a recalibration can
	 * re-place everything without tearing down panels that currently hold the student's text.
	 */
	applyUiLayout() {
		const { panelX, panelBottom, panelZ, btnX, btnY } = this.ui;
		this.prompt.group.position.set(panelX, panelBottom, panelZ);
		this.feedback.group.position.set(panelX, panelBottom, panelZ);
		this.continueBtn.position.set(btnX, btnY, panelZ);
		if (this.hoverLine) this.hoverLine.position.set(panelX, panelBottom - 0.022, panelZ);
		this.placeCalloutPanel();
		if (this.quizPlates?.length) this.placeQuiz();
		if (this.backBtn) {
			this.backBtn.position.set(this.ui.navX, this.ui.navTopY, this.ui.panelZ);
			this.resetBtn.position.set(this.ui.navX, this.ui.navTopY - this.ui.navGap, this.ui.panelZ);
		}
		this.relayout();
	}

	/**
	 * Re-plan the UI around the student's REAL eye height.
	 *
	 * Every card position derives from `ui.eyeY`, which was authored as a single constant
	 * (1.45 m) — an adult's eye height. This lesson ships a "ms" register for grades 6-8,
	 * where eye height is nearer 1.25-1.35 m, so those students got the whole interface
	 * floating above their natural gaze with no way to fix it. The headset already knows
	 * the answer: with a local-floor reference space the camera's world Y *is* head height.
	 *
	 * Panel widths are deliberately NOT rebuilt. A Panel's backdrop geometry is fixed at
	 * construction, and tearing the panels down mid-lesson would discard the text the
	 * student is reading; the residual width error from a 20 cm height change is far
	 * smaller than the vertical error this corrects.
	 */
	calibrateEye(y) {
		// Reject implausible samples outright: a dropped tracking frame reports 0, and
		// calibrating to the floor would throw the lesson out of view entirely.
		if (!Number.isFinite(y) || y < 0.8 || y > 2.2) return false;
		// Ignore churn. Re-planning on every tiny head bob would make the cards swim.
		if (Math.abs(y - this.ui.eyeY) < 0.03) return false;
		this.ui.eyeY = y;
		this.planUi();
		this.applyUiLayout();
		this.fire('eye-calibrated');
		return true;
	}

	/** Callout card grows UP from the same bottom line as the prompt stack, on the far side. */
	placeCalloutPanel() {
		const h = this.calloutPanel.height || 0.04;
		this.calloutPanel.group.position.set(this.ui.calloutX, this.ui.panelBottom + h, this.ui.panelZ);
	}

	/** Which callouts belong to the current step. Test steps hide them unless listed explicitly. */
	calloutActive(c) {
		if (this.done) return false;
		const st = this.steps[this.i];
		if (!st) return false;
		if (Array.isArray(c.spec.steps)) return c.spec.steps.includes(st.id);
		const a = st.action || {};
		return !a.flow && !a.reassemble && !a.quiz;
	}

	refreshCallouts() {
		for (const c of this.callouts) c.marker.visible = this.calloutActive(c);
		if (this.calloutOpen != null && !this.callouts[this.calloutOpen].marker.visible) this.closeCallout();
		this.hoverCallout(-1);
	}

	/** Re-anchor every visible marker to its part; parts move during explode/scatter. */
	placeCallouts() {
		const s = this.model.group.scale.x;
		const eye = this.camera.getWorldPosition(this._calloutEye || (this._calloutEye = new THREE.Vector3()));
		const toEye = this._calloutDir || (this._calloutDir = new THREE.Vector3());
		const rel = this._calloutRel || (this._calloutRel = new THREE.Vector3());
		const standoff = this.data.runtime?.calloutStandoffMetres ?? 0.012;
		for (const c of this.callouts) {
			if (!c.marker.visible) continue;
			const centre = this.model.center(c.spec.anchor);
			c.marker.position.copy(centre).addScaledVector(c.offset, s);
			// Keep the marker on the NEAR side of its own part. The authored offset is relative
			// to the part, not to the viewer, so from the seated eye the left-ventricle marker
			// sat 4 cm INSIDE the organ - the one launcher in the lesson was invisible. Only
			// the depth toward the eye is corrected; the authored sideways/vertical placement
			// is kept. Analytic, not a raycast, because this runs every frame on a 149k-tri model.
			toEye.copy(eye).sub(centre).normalize();
			const depth = rel.copy(c.marker.position).sub(centre).dot(toEye);
			const need = this.model.radius(c.spec.anchor) + standoff;
			if (depth < need) c.marker.position.addScaledVector(toEye, need - depth);
		}
	}

	/** Nearest visible callout dot on the ray, or null. Returns { index, distance }. */
	pickCallout(ray) {
		const dots = this.calloutDots.filter((d) => d.parent.visible);
		if (!dots.length) return null;
		// Dots are 15 mm across — too small to hit reliably with a hand ray at arm's length, so
		// test a generous proxy radius the same way the parts use hit spheres.
		const proxy = this.data.runtime?.calloutHitMetres ?? 0.02;
		let best = null;
		const p = new THREE.Vector3();
		for (const d of dots) {
			d.getWorldPosition(p);
			const t = p.clone().sub(ray.ray.origin).dot(ray.ray.direction);
			if (t < 0) continue;
			if (ray.ray.distanceSqToPoint(p) > proxy * proxy) continue;
			if (!best || t < best.distance) best = { index: d.userData.calloutIndex, distance: t };
		}
		return best;
	}

	hoverCallout(i) {
		// Normalise before the equality check: update() passes -1 for "nothing", and comparing
		// -1 against a stored null never matches, so this ran its full body every idle frame.
		const next = i >= 0 ? i : null;
		if (this.calloutHover === next) return;
		const prev = this.callouts[this.calloutHover];
		if (prev) {
			prev.dot.material.color.setHex(prev.tint);
			prev.dot.scale.setScalar(1);
			prev.hover.visible = false;
		}
		this.calloutHover = next;
		const c = this.callouts[next];
		if (c) {
			c.dot.material.color.setHex(0xffffff);
			c.dot.scale.setScalar(1.4);
			// Say what the marker DOES, not only what it is about: a student reading just the
			// title has no way to know this one opens footage rather than a text card.
			c.hover.userData.text.text = c.isVideo
				? `Watch: ${this.textOf(c.spec.title)}`
				: this.textOf(c.spec.title);
			c.hover.userData.text.sync();
			c.hover.visible = true;
		}
	}

	openCallout(i) {
		const c = this.callouts[i];
		if (!c) return;
		this.calloutOpen = i;
		const title = this.textOf(c.spec.title);
		const body = this.textOf(c.spec.text);
		this.calloutPanel.set(title ? `${title}\n\n${body}` : body, 0xffffff);
		this.calloutPanel.group.visible = true;
		this.calloutLine.visible = true;
		this.placeCalloutPanel();
		this.fire('callout-open', c.spec.id);
	}

	closeCallout() {
		if (this.calloutOpen == null) return;
		const id = this.callouts[this.calloutOpen]?.spec.id;
		this.calloutOpen = null;
		this.calloutPanel.group.visible = false;
		this.calloutLine.visible = false;
		this.fire('callout-close', id);
	}

	/** Trigger handler for callouts. Returns true when the press was consumed. */
	pressCallout() {
		if (this.calloutHover == null) return false;
		if (this.calloutOpen === this.calloutHover) {
			this.closeCallout();
			return true;
		}
		const c = this.callouts[this.calloutHover];
		// A callout that carries a clip plays it instead of showing its card. The card is not
		// lost: closeVideo() opens it afterwards, so the student gets the footage and then the
		// written explanation rather than one covering the other.
		if (c?.spec.video && this.openVideo(c.spec.video, c.spec.videoAt)) {
			this.videoFromCallout = this.calloutHover;
			this.closeCallout();
			return true;
		}
		this.openCallout(this.calloutHover);
		return true;
	}

	/**
	 * Everything the lesson draws that is NEARER than the video panel, and would therefore
	 * punch through it. The clip sits at ~1.35 m while the cards sit at ~0.62 m and the
	 * anatomy nearer still, so without this the student watches a lecture with a prompt card
	 * and a callout dot floating on top of the footage.
	 */
	videoMaskTargets() {
		return [
			this.model.group,
			this.labelGroup,
			this.lineGroup,
			this.waypointGroup,
			this.calloutGroup,
			this.quizGroup,
			this.prompt.group,
			this.feedback.group,
			this.continueBtn,
			this.calloutPanel.group,
			this.calloutLine,
			this.badge,
			this.backBtn,
			this.resetBtn,
			this.hoverLine,
			this.selGroup,
			this.selLine,
		].filter(Boolean);
	}

	/** Stash current visibility and blank the lesson for the duration of a clip. */
	hideForVideo() {
		if (this._maskBackup) return;
		this._maskBackup = this.videoMaskTargets().map((o) => [o, o.visible]);
		for (const [o] of this._maskBackup) o.visible = false;
	}

	/** Put back exactly what was showing before, not a guess at what should be. */
	restoreAfterVideo() {
		for (const [o, v] of this._maskBackup || []) o.visible = v;
		this._maskBackup = null;
	}

	/** Open a clip and blank the lesson behind it. */
	openVideo(id, at) {
		if (!this.video.open(id, at)) return false;
		this.hideForVideo();
		this.fire('video-open', id);
		return true;
	}

	/** Close a clip and restore the lesson, without showing any follow-up card. */
	dismissVideo() {
		if (!this.video.close()) return false;
		this.restoreAfterVideo();
		this.videoFromCallout = null;
		this.videoHover = null;
		return true;
	}

	/**
	 * Squeeze pressed: take hold of whatever the pointer is on.
	 *
	 * Deliberately refused during a clip or the quiz. Both cover the anatomy, so a grab there
	 * would silently rearrange a model the student cannot see and cannot put back.
	 */
	grabStart(hand, controllers, via = 'triggers') {
		if (this.grab) return false;
		if (this.video.isOpen || this.quiz) return false;
		const id = this.hover;
		if (!id) return false;
		const ct = controllers?.[hand];
		if (!ct?.gripSpace) return false;
		const start = this.model.beginGrab(id);
		if (!start) return false;
		const handWorld = ct.gripSpace.getWorldPosition(new THREE.Vector3());
		const handQuat = ct.gripSpace.getWorldQuaternion(new THREE.Quaternion());
		// Record the hand's pose at grab time and the part's pose relative to it. Everything
		// afterwards is expressed as the DELTA from this, so the part neither jumps on grab nor
		// inherits whatever absolute angle the controller happened to be at.
		this.grab = {
			id,
			hand,
			// Which gesture opened this grab. The release rules differ, and without this a
			// squeeze-held part was dropped a frame later by the both-triggers release check.
			via,
			offset: start.pos.clone().sub(handWorld),
			handQuat0: handQuat.clone(),
			handQuat0Inv: handQuat.clone().invert(),
			partQuat0: start.quat.clone(),
		};
		this.model.highlight(id, true);
		this.fire('grab-start', id);
		return true;
	}

	/**
	 * End a grab. A release only counts if it comes from the hand that started it AND from the
	 * same gesture, so letting go of a squeeze cannot cancel a trigger grab or vice versa.
	 */
	grabEnd(hand, via) {
		if (!this.grab) return false;
		if (hand && this.grab.hand !== hand) return false;
		if (via && this.grab.via !== via) return false;
		const id = this.grab.id;
		this.model.endGrab(id);
		this.model.highlight(id, false);
		this.grab = null;
		this.fire('grab-end', id);
		return true;
	}

	/** Per-frame: drive the held part from the grip pose. */
	updateGrab(controllers) {
		if (!this.grab) return;
		const ct = controllers?.[this.grab.hand];
		// A controller that sleeps or loses tracking mid-grab must not leave a part welded to a
		// stale pose; drop it where it is.
		if (!ct?.gripSpace?.visible) {
			this.grabEnd();
			return;
		}
		const g = this.grab;
		const handWorld = ct.gripSpace.getWorldPosition(this.t).clone();
		const handQuat = ct.gripSpace.getWorldQuaternion(new THREE.Quaternion());
		// How far the wrist has turned since the grab began.
		const delta = handQuat.clone().multiply(g.handQuat0Inv);
		// The part orbits the hand rather than spinning in place: the offset is rotated by the
		// same delta, so turning the wrist swings the part around the hand the way a held
		// object behaves, instead of pivoting about its own origin while hanging in mid-air.
		const pos = handWorld.add(g.offset.clone().applyQuaternion(delta));
		const quat = delta.clone().multiply(g.partQuat0);
		this.model.setGrabWorld(g.id, pos, quat);
	}

	/**
	 * Push the explosion further apart, or back together. Driven by the thumbstick.
	 *
	 * The authored spread leaves 5 of the 14 parts hidden behind another from a seated eye
	 * position, and no single fixed value fixes that for everyone: the separation that reveals
	 * a papillary muscle also lifts the valve plane far above the gaze. So the amount is the
	 * student's to choose, and it resets with each step.
	 */
	adjustSpread(delta) {
		if (this.video.isOpen || this.quiz) return false;
		const next = THREE.MathUtils.clamp(this.extraSpread + delta, 0, this.maxExtraSpread);
		if (Math.abs(next - this.extraSpread) < 1e-5) return false;
		this.extraSpread = next;
		// Only drive the model directly when no tween is running: the tween loop adds the boost
		// itself, so doing it here as well would double-apply for those frames.
		if (!this.tweens.length) this.model.setFactor(this.stepFactor + this.extraSpread);
		return true;
	}

	/** Hover tint for the two video plates. */
	setVideoBtn(btn, on) {
		btn.userData.plate.material.color.setHex(on ? 0x4d8fd6 : 0x2f6fb3);
	}

	/** Hover feedback for the skinned nav buttons: the skin is a texture, so tint the map. */
	hoverNav(kind) {
		if (this.navHover === kind) return;
		this.navHover = kind;
		for (const [k, btn] of Object.entries(this.navBtns)) {
			btn.userData.material.color.setHex(k === kind ? 0xffffff : 0xc8d4de);
			btn.scale.setScalar(k === kind ? 1.04 : 1);
		}
	}

	/** Nearest nav plate under the ray, or null. */
	pickNav(ray) {
		let best = null;
		for (const [kind, btn] of Object.entries(this.navBtns)) {
			if (!btn.visible) continue;
			const hit = ray.intersectObject(btn.userData.plate, false)[0];
			if (hit && (!best || hit.distance < best.distance)) best = { kind, distance: hit.distance };
		}
		return best;
	}

	syncResetLabel() {
		setButtonLabel(this.resetBtn, this.resetArmed > 0 ? 'Press again' : 'Full Reset');
	}

	/**
	 * Trigger on a nav button. Full Reset asks twice.
	 *
	 * One press wipes a student's whole lesson, and the button must sit within easy reach of a
	 * hand ray - which is exactly the condition for a mis-aimed press. The second press is the
	 * confirmation, and the arm lapses so a student who walks away cannot leave it primed for
	 * whoever picks the headset up next.
	 */
	pressNav() {
		if (!this.navHover) return false;
		if (this.navHover === 'back') {
			this.resetArmed = 0;
			this.syncResetLabel();
			if (this.i > 0) this.prev();
			else this.say('This is the first step.', MUTED);
			this.fire('back');
			return true;
		}
		if (this.resetArmed > 0) {
			this.resetArmed = 0;
			this.reset();
			this.syncResetLabel();
			this.fire('full-reset');
			return true;
		}
		this.resetArmed = 4;
		this.syncResetLabel();
		this.say('Press Full Reset again to clear everything for the next student.', MUTED);
		return true;
	}

	/** Close the clip and hand the student the written version of the same point. */
	closeVideo() {
		const i = this.videoFromCallout;
		if (!this.dismissVideo()) return false;
		if (i != null) this.openCallout(i);
		this.fire('video-close');
		return true;
	}

	/**
	 * Trigger while a clip is up. Close and Mute are the only live targets; a press anywhere
	 * else on the panel is swallowed so the student cannot pick apart the anatomy they cannot
	 * currently see.
	 */
	pressVideo() {
		if (!this.video.isOpen) return false;
		if (this.videoHover === 'close') return this.closeVideo();
		if (this.videoHover === 'mute') return this.video.toggleMute();
		return true;
	}

	/**
	 * Lay the choice plates out in a vertical stack on the side of the view the prompt card
	 * does not use, measured from the same angular spec as everything else.
	 */
	placeQuiz() {
		const qh = this.ui.feedText * this.quizPlateMul;
		const pitch = qh * this.quizPitchMul;
		const top = this.ui.eyeY + this.ui.panelZ * Math.tan(THREE.MathUtils.degToRad(-4));
		this.quizPlates.forEach((pl, i) => {
			pl.position.set(this.ui.calloutX, top - i * pitch, this.ui.panelZ);
		});
	}

	/** Start the quiz: question order as authored, CHOICES shuffled (see shuffleChoices). */
	enterQuiz() {
		const qs = this.data.quiz || [];
		this.quiz = { i: 0, score: 0, answered: false, total: qs.length, order: null, stage: 'intro' };
		this.quizGroup.visible = qs.length > 0;
		this.placeQuiz();
		if (qs.length) this.showQuizTitle();
		return qs.length;
	}

	/**
	 * The quiz's title card. Without it the step went straight from the step card to
	 * "Question 1 of 4" with the answer plates already live, so a student still reading
	 * the step text could fire a trigger at a plate and answer before seeing the question.
	 * The card says what is coming and that nothing is recorded, and waits for an explicit
	 * Start - on the plate where the answers will appear, or on Continue.
	 */
	showQuizTitle() {
		const st = this.steps[this.i];
		const n = this.quiz.total;
		const mins = st?.minutes ? ` · about ${st.minutes} min` : '';
		this.prompt.set(
			`QUIZ\n\n${st?.title ?? 'Check your understanding'}\n\n` +
				`${n} question${n === 1 ? '' : 's'}${mins}\n\n` +
				`${this.textOf(st?.prompt) || 'Point at an answer and pull the trigger.'} ` +
				`The reason is shown after every answer. Your score is shown only to you and is not saved.`,
		);
		this.quizPlates.forEach((pl, k) => {
			pl.visible = k === 0;
			if (k !== 0) return;
			pl.userData.caption.text = 'Start quiz';
			pl.userData.caption.sync();
			this.setPlate(pl, 'idle');
		});
		this.clearSay();
		this.setContinueEnabled(true);
		this.relayout();
	}

	/** Leave the title card and present the first question. */
	startQuiz() {
		if (!this.quiz || this.quiz.stage !== 'intro') return false;
		this.quiz.stage = 'questions';
		this.quizHover = null;
		this.showQuestion(0);
		this.fire('quiz-start');
		return true;
	}

	/**
	 * Present one question. Choice order is randomised per question because every authored
	 * `answer` is index 0 - rendered as written, the correct option is always the first plate
	 * and the quiz measures pattern-spotting instead of anatomy.
	 */
	showQuestion(i) {
		const q = this.data.quiz[i];
		if (!q) return;
		this.quiz.i = i;
		this.quiz.answered = false;
		const idx = q.choices.map((_, k) => k);
		for (let k = idx.length - 1; k > 0; k--) {
			const j = Math.floor(Math.random() * (k + 1));
			[idx[k], idx[j]] = [idx[j], idx[k]];
		}
		this.quiz.order = idx;
		this.prompt.set(`Question ${i + 1} of ${this.quiz.total}\n\n${q.q}`);
		this.quizPlates.forEach((pl, k) => {
			const has = k < idx.length;
			pl.visible = has;
			if (!has) return;
			pl.userData.caption.text = q.choices[idx[k]];
			pl.userData.caption.sync();
			this.setPlate(pl, 'idle');
		});
		this.clearSay();
		this.setContinueEnabled(false);
		this.relayout();
	}

	/** Highlight the plate under the ray, unless the question is already scored. */
	hoverQuiz(i) {
		if (this.quizHover === i) return;
		const prev = this.quizPlates?.[this.quizHover];
		if (prev && this.quiz && !this.quiz.answered) prev.userData.plate.material.color.setHex(0x2f6fb3);
		this.quizHover = i;
		const pl = this.quizPlates?.[i];
		if (pl && this.quiz && !this.quiz.answered) pl.userData.plate.material.color.setHex(0x4d8fd6);
	}

	/** Plate colouring. Shape/position never changes, so this is never the only signal. */
	setPlate(pl, kind) {
		const col = { idle: 0x2f6fb3, right: 0x2f8f4f, wrong: 0x7d3027, dim: 0x3a4550 }[kind];
		pl.userData.plate.material.color.setHex(col);
		pl.userData.caption.color = kind === 'dim' ? 0x8a97a3 : 0xffffff;
		pl.userData.caption.sync();
	}

	/** Nearest visible choice plate under the ray, or null. */
	pickQuiz(ray) {
		if (!this.quizGroup.visible) return null;
		let best = null;
		for (const pl of this.quizPlates) {
			if (!pl.visible) continue;
			const hit = ray.intersectObject(pl.userData.plate, false)[0];
			if (hit && (!best || hit.distance < best.distance)) best = { plate: pl, distance: hit.distance };
		}
		return best;
	}

	/** Trigger on a choice. Returns true when the press was consumed. */
	pressQuiz() {
		if (!this.quiz || this.quizHover == null) return false;
		if (this.quiz.stage === 'intro') return this.startQuiz();
		if (this.quiz.answered) return true; // already scored; Continue moves on
		const q = this.data.quiz[this.quiz.i];
		const picked = this.quiz.order[this.quizHover];
		const right = picked === q.answer;
		this.quiz.answered = true;
		if (right) this.quiz.score += 1;
		// Always reveal which option was correct: a wrong answer with no correction teaches
		// nothing, and this lesson's whole stance is immediate formative feedback.
		this.quizPlates.forEach((pl, k) => {
			if (!pl.visible) return;
			if (this.quiz.order[k] === q.answer) this.setPlate(pl, 'right');
			else if (k === this.quizHover) this.setPlate(pl, 'wrong');
			else this.setPlate(pl, 'dim');
		});
		this.say(right ? `Correct. ${this.textOf(q.why)}` : `Not quite. ${this.textOf(q.why)}`, right ? OK : BAD);
		this.setContinueEnabled(true);
		this.fire(right ? 'quiz-ok' : 'quiz-miss');
		return true;
	}

	/** Continue pressed during the quiz: next question, or wrap up. Returns true if handled. */
	nextQuestion() {
		if (!this.quiz) return false;
		if (this.quiz.stage === 'intro') return this.startQuiz();
		if (this.quiz.stage === 'results') {
			// Second Continue on the results card: leave the quiz and let the lesson finish.
			this.quizGroup.visible = false;
			this.quizHover = null;
			this.quiz = null;
			return false; // let the caller fall through to finish()
		}
		if (!this.quiz.answered) return true; // must answer before advancing
		if (this.quiz.i < this.quiz.total - 1) {
			this.showQuestion(this.quiz.i + 1);
			return true;
		}
		this.showQuizResults();
		return true;
	}

	/**
	 * The quiz's closing card, held until Continue.
	 *
	 * The score used to be written to the feedback line and then handed straight to finish()
	 * in the same frame, which overwrote it - so no student ever saw their result. It now
	 * gets a card of its own. Shown once and never stored: the classroom rule is no records.
	 */
	showQuizResults() {
		const { score, total } = this.quiz;
		this.quiz.stage = 'results';
		this.quizPlates.forEach((pl) => (pl.visible = false));
		this.quizHover = null;
		const note =
			score === total
				? 'Every one right.'
				: score >= Math.ceil(total / 2)
					? 'Good. The reasons you just read are the part worth keeping.'
					: 'Worth another pass: go Back to any step and look again.';
		this.prompt.set(`QUIZ COMPLETE\n\nYou answered ${score} of ${total} correctly.\n\n${note}\n\nThis score is not saved.`);
		this.clearSay();
		this.setContinueEnabled(true);
		this.relayout();
		this.fire('quiz-done');
	}

	/** Build the leader-line labels for the core (pointable) tier. */
	buildLabels(ids) {
		for (const c of this.labelGroup.children.slice()) {
			c.userData.text.dispose?.();
			this.labelGroup.remove(c);
		}
		for (const l of this.lineGroup.children.slice()) {
			l.geometry.dispose?.();
			l.material.dispose?.();
			this.lineGroup.remove(l);
		}
		const core = new Set(ids || this.data.tiers.core);
		for (const id of core) {
			if (!this.model.parts.has(id)) continue;
			const lab = makeLabel(this.data.runtime.labelTextHeightMetres);
			lab.userData.id = id;
			lab.userData.line = makeLeaderLine();
			this.labelGroup.add(lab);
			this.lineGroup.add(lab.userData.line);
			lab.userData.text.text = this.partName(id);
			lab.userData.text.sync();
		}
	}

	buildWaypoints() {
		for (const c of this.waypointGroup.children.slice()) this.waypointGroup.remove(c);
		for (const hop of this.data.flow.order) {
			if (hop.kind !== 'waypoint') continue;
			const g = new THREE.Group();
			const dot = new THREE.Mesh(
				new THREE.SphereGeometry(0.008, 12, 10),
				new THREE.MeshBasicMaterial({ color: 0xf0c14b }),
			);
			// Waypoint labels carry the dot's colour so the pairing reads without a legend.
			const lab = makeLabel((this.data.runtime || {}).waypointTextHeightMetres ?? 0.017, 0xf0c14b);
			lab.userData.text.text = hop.label;
			lab.userData.text.sync();
			g.add(dot, lab);
			g.userData.hop = hop;
			g.userData.dot = dot;
			g.userData.lab = lab;
			this.waypointGroup.add(g);
		}
		this.placeWaypoints();
	}

	/** Waypoint markers are schematic: they are anchored to real parts, not modelled as vessels. */
	placeWaypoints() {
		const s = this.model.group.scale.x;
		const mid = this.model.centre();
		this.waypointGroup.children.forEach((g, i) => {
			const hop = g.userData.hop;
			const anchor = this.model.center(hop.anchor);
			const off = new THREE.Vector3(hop.offset[0] * s, hop.offset[1] * s, hop.offset[2] * s);
			const p = anchor.add(off);
			g.position.copy(p);
			// Push labels outward from the model centre and stagger them by hop index: the flow
			// anchors sit close together, and stacked labels over the vessels read as one blob.
			const out = p.clone().sub(mid);
			out.y = 0;
			if (out.lengthSq() < 1e-6) out.set(1, 0, 0);
			out.normalize();
			const reach = 0.06 + i * 0.012;
			g.userData.lab.position.set(out.x * reach, 0.03 + (i % 2) * 0.055, out.z * reach);
		});
	}

	flowParts() {
		return this.data.flow.order.filter((h) => h.kind === 'part').map((h) => h.id);
	}

	enterStep(i) {
		this.i = Math.max(0, Math.min(this.steps.length - 1, i));
		// A faded-out blocker from the previous step must not silently stay out of the pick set.
		this.blockedOut = [];
		const st = this.steps[this.i];
		const a = st.action || {};

		this.model.clearLook();
		// `labels` is either 'core' (every pointable part), 'none', or an explicit id list. Step 2
		// names only the four chambers because that is what the step asks the student to do, and
		// eight full anatomical names will not fit on one arc: a name like "Right cardiac atrium"
		// is about 21 degrees wide at label distance, so more than ~5 of them overlap no matter how
		// they are fanned. Everything else stays available by pointing at it.
		const labelIds = a.labels === 'core' ? this.data.tiers.core : Array.isArray(a.labels) ? a.labels : null;
		this.labelGroup.visible = !!labelIds;
		// Leader lines live in their own group and are only rebuilt when the NEXT step has labels
		// of its own. Without this, step 2's four leaders carried into step 3 frozen where the
		// exploded parts used to be, pointing at empty space beside the reassembled heart.
		this.lineGroup.visible = !!labelIds;
		this.waypointGroup.visible = !!a.flow;
		if (labelIds) this.buildLabels(labelIds);
		this.hover = null;
		// The name of a part pressed in the previous step would otherwise hang over anatomy
		// the new step may have rearranged or hidden.
		this.clearSelected();

		if (a.isolate) this.model.isolate(a.isolate);
		if (a.ghost) this.model.ghost(a.ghost);
		if (a.flow) {
			this.flow = { i: 0, misses: 0 };
			this.buildWaypoints();
			const first = this.flowParts()[0];
			if (first) this.revealPathTo(first);
		}
		// A clip must never survive a step change: it would hide the next step entirely.
		this.dismissVideo();
		// Each step authors its own arrangement (isolate/ghost/explode), so hand-displaced parts
		// go home on a step change or the next step sets up over a model the student rearranged.
		this.grabEnd();
		// Glide hand-moved parts home rather than teleporting them (Full Reset stays instant).
		this.model.homeMoved(0.8);
		if (!a.quiz && (this.quiz || this.quizGroup.visible)) {
			// Leaving the quiz by any route (prev(), reset()) must take its plates with it.
			this.quiz = null;
			this.quizGroup.visible = false;
			this.quizHover = null;
		}
		if (a.reassemble) {
			this.find = { queue: this.shuffle(this.data.tiers.core.filter((id) => this.model.parts.has(id))), asked: null, misses: 0 };
			this.nextAsk();
		}

		const target = Array.isArray(a.explode) ? a.explode[1] : a.explode ?? 0;
		// A new step owns the arrangement, so the previous step's extra spread is dropped.
		this.stepFactor = target;
		this.extraSpread = 0;
		if (a.reassemble) this.model.scatter();
		// Coming back TOGETHER is quick and eases OUT, so it visibly starts moving the instant
		// Continue is pressed. It used to reuse the 5 s ease-in-out built for the slow explode
		// reveal, which barely moved for the first second and read as "nothing happened".
		const collapsing = target < this.model.factor - 1e-4;
		if (collapsing) this.tweenFactor(target, 0.8, 'out');
		else this.tweenFactor(target, a.explode === 0 ? 0.6 : 5.0);

		this.prompt.set(`Step ${this.i + 1} of ${this.steps.length} · ${st.title}\n\n${st.verb.toUpperCase()} — ${this.textOf(st.prompt)}`);
		this.say(this.misconceptionFor(st.id));
		this.setContinueEnabled(!a.flow && !a.reassemble && !a.quiz);
		this.relayout();
		this.refreshCallouts();
		// Started last on purpose: showQuestion() writes the question onto the prompt card, so
		// it has to run after the generic step card above or the question never appears.
		if (a.quiz) this.enterQuiz();
		this.fire('step', st.id);
		return st;
	}

	misconceptionFor(stepId) {
		const m = (this.data.misconceptions || []).find((x) => x.step === stepId);
		return m ? this.textOf(m.surfaceAs) : '';
	}

	/**
	 * Ghost whatever is blocking the line from the student's eyes to the part they were asked for.
	 * Why this instead of rotating the heart: the left atrium really is posterior, so an anterior
	 * view legitimately hides it — and a student who cannot point at the asked part is a stuck
	 * student. Making the occluders translucent shows WHY it was hidden, which is the lesson.
	 */
	revealPathTo(id) {
		const eye = this.camera.getWorldPosition(new THREE.Vector3());
		const c = this.model.center(id);
		const dir = c.clone().sub(eye);
		const dist = dir.length();
		if (dist < 1e-6) return [];
		const far = this.ray.far;
		this.ray.set(eye.clone(), dir.normalize());
		this.ray.far = dist - 0.004;
		const along = this.model.pickAll(this.ray);
		this.ray.far = far;
		const blockers = along.filter((x) => x !== id);
		if (blockers.length) this.model.ghost(blockers, 0.3);
		// Translucent is not enough: a see-through wall is still solid to a raycast, so the blocker
		// must also step out of the pick set. Every other part stays pointable, so a wrong answer
		// still means the student picked a real structure and we can name it back to them.
		this.blockedOut = blockers;
		return blockers;
	}

	/** Pick options for the current step: everything except what we just faded out of the way. */
	pickOpts() {
		const opts = { hitSphereMinMetres: this.data.runtime.hitSphereMinMetres };
		if (this.blockedOut && this.blockedOut.length) {
			opts.only = new Set([...this.model.parts.keys()].filter((id) => !this.blockedOut.includes(id)));
		}
		return opts;
	}

	nextAsk() {
		if (!this.find.queue.length) {
			this.find.asked = null;
			this.say(`Heart reassembled. You named all ${this.data.tiers.core.length}.`, OK);
			// The detail-tier parts were never pointing targets, so bring them home with a glide
			// and make the claim in the message true.
			this.tweenFactor(0, 2.0);
			this.setContinueEnabled(true);
			return null;
		}
		this.find.asked = this.find.queue[0];
		this.find.misses = 0;
		// Get the view out of the way of whatever we just asked for, so a student is never left
		// poking a wall because the asked part happens to sit behind another chamber.
		this.revealPathTo(this.find.asked);
		// The part name here is the task, not commentary — white, like the prompt card.
		this.say(`Find it: ${this.partName(this.find.asked)}`, 0xffffff);
		return this.find.asked;
	}

	shuffle(arr) {
		const a = arr.slice();
		for (let i = a.length - 1; i > 0; i--) {
			const j = (i + 1) * 1103515245 % (i + 1) >>> 0;
			[a[i], a[j]] = [a[j], a[i]];
		}
		return a;
	}

	say(msg, color = MUTED) {
		if (!msg) return; // most callers pass an optional line; an absent line must not wipe feedback
		this.feedback.set(msg, color);
		// The semantic is derived from the colour constant rather than passed separately: OK,
		// BAD and MUTED exist precisely to mean right / wrong / neutral, so reading them here
		// keeps one source of truth and no call site can set a badge that contradicts its card.
		this.setBadge(color === OK ? 'ok' : color === BAD ? 'bad' : null);
		this.relayout();
	}

	/** Show the shape that duplicates the feedback colour, or none for neutral text. */
	setBadge(kind) {
		const b = this.badge?.userData;
		if (!b) return;
		b.ok.visible = kind === 'ok';
		b.bad.visible = kind === 'bad';
		this.badgeKind = kind;
	}

	/** Explicit wipe. `say('')` cannot do this: `say` ignores empty messages on purpose. */
	clearSay() {
		this.feedback.set('', MUTED);
		this.setBadge(null);
		this.relayout();
	}

	relayout() {
		// A Panel's local origin is its TOP edge, and it grows DOWNWARD. Anchor the stack by its
		// bottom line and grow up, or a longer prompt grows straight down over the anatomy.
		const b = this.ui.panelBottom;
		// Heights are measured, and an empty panel now reports height 0 with no backdrop, so the
		// prompt card drops onto the stack's bottom line instead of leaving a reserved slot (and
		// a visible gap) for a card that says nothing.
		const fh = this.feedback.height || 0;
		const ph = this.prompt.height || 0.04;
		const gap = fh ? 0.012 : 0;
		// Derive visibility here rather than trusting fit(): a step entry that clears the text
		// directly (not through set()) never re-fits, leaving a stale visible flag on a
		// zero-scaled backdrop that would reappear if anything else touched that scale.
		this.feedback.back.visible = fh > 0;
		this.feedback.group.position.y = b + fh;
		this.prompt.group.position.y = b + fh + gap + ph;
		// Badge rides just outside the card's outer edge (away from the anatomy) on the first
		// text line, and disappears with the card so an empty panel shows no orphan mark.
		if (this.badge) {
			const outward = Math.sign(this.ui.panelX) || -1;
			this.badge.position.set(
				this.ui.panelX + outward * (this.ui.panelW / 2 + this.ui.feedText * 0.95),
				b + fh - this.ui.feedText * 0.75,
				this.ui.panelZ,
			);
			// relayout() can fire from a troika sync callback at any time, including while a clip
			// is up, so it must respect the video mask or the badge pops back through the panel.
			this.badge.visible = !this._maskBackup && fh > 0 && !!this.badgeKind;
		}
		this.panelBottomY = b;
	}

	setContinueEnabled(on) {
		this.continueOn = on;
		this.continueBtn.userData.plate.material.color.setHex(on ? 0x2f6fb3 : 0x3a4550);
		this.continueBtn.userData.caption.color = on ? 0xffffff : 0x8a97a3;
		this.continueBtn.userData.caption.sync();
	}

	tweenFactor(to, dur, ease = 'inOut') {
		this.tweens = this.tweens.filter((tw) => !tw.factor);
		if (Math.abs(this.model.factor - to) < 1e-4) {
			this.model.setFactor(to);
			return;
		}
		this.tweens.push({ factor: true, from: this.model.factor, to, t: 0, dur, ease });
	}

	next() {
		if (!this.continueOn) return false;
		// During the quiz, Continue steps through questions; only the last one falls through.
		if (this.quiz && this.nextQuestion()) return true;
		if (this.i >= this.steps.length - 1) {
			this.finish();
			return true;
		}
		this.enterStep(this.i + 1);
		return true;
	}

	prev() {
		if (this.i > 0) this.enterStep(this.i - 1);
	}

	finish() {
		this.done = true;
		this.refreshCallouts();
		this.labelGroup.visible = false;
		this.waypointGroup.visible = false;
		this.model.clearLook();
		this.tweenFactor(0, 2.5);
		this.prompt.set(`${this.data.title} — done. ${this.data.credits}`, 0xffffff);
		this.say('Press the trigger anywhere to start again for the next student.', OK);
		this.setContinueEnabled(true);
		this.fire('finish');
	}

	/** Reset for the next student: full state wipe, no records kept anywhere. */
	reset() {
		// A classroom reset must leave no residue for the next student. Flow counters, highlights,
		// tweens and per-part scatter flags used to survive, so the next student inherited the last
		// student's progress as the first thing they saw.
		this.done = false;
		this.flow = null;
		this.find = { queue: [], asked: null, misses: 0 };
		this.quiz = null;
		this.quizHover = null;
		if (this.quizGroup) this.quizGroup.visible = false;
		this.tweens = [];
		this._lit = null;
		if (this.hover) this.model.highlight(this.hover, false);
		this.hover = null;
		this.hoverSay('');
		this.clearSay();
		this.closeCallout();
		this.clearSelected();
		this.dismissVideo();
		this.grabEnd();
		this.model.returnMoved();
		this.model.clearLook();
		this.extraSpread = 0;
		this.model.scatter();
		this.model.setFactor(0);
		this.enterStep(0);
	}

	hoverPart(id) {
		if (this.hover === id) return;
		if (this.hover) this.model.highlight(this.hover, false);
		this.hover = id;
		if (id) {
			this.model.highlight(id, true);
			const st = this.steps[this.i];
			if (st?.action?.hoverNames) this.hoverSay(this.partName(id));
		}
	}

	/**
	 * Name the selected part where the part IS, with a leader line back to it.
	 *
	 * Deliberately separate from the hover readout: hover is transient and follows the ray, so
	 * it cannot answer "which one did I just press?" a moment later. Shown for every press,
	 * right or wrong - naming what you touched is not a claim that it was correct, and the
	 * badge and the card already carry correctness.
	 */
	showSelected(id) {
		if (!id || !this.model.parts.get(id)) return this.clearSelected();
		this.selId = id;
		this.selLabel.userData.text.text = this.partName(id);
		this.selLabel.userData.text.sync();
		this.selGroup.visible = true;
		this.selLine.visible = true;
		this.placeSelected();
		return true;
	}

	clearSelected() {
		this.selId = null;
		this.selGroup.visible = false;
		this.selLine.visible = false;
		return false;
	}

	/** Re-anchor the selected label; the part moves under explode, grab and scatter. */
	placeSelected() {
		if (!this.selId || !this.selGroup.visible) return;
		const s = this.model.group.scale.x;
		const at = this.model.center(this.selId);
		// Lifted along the model's own scale so the label clears the surface at any size, and
		// higher than a callout dot so the two never occupy the same spot.
		// Lifted clear of the callout markers, which sit ~0.05 model units above the same part
		// and would otherwise share the spot with the name.
		const label = at.clone().addScaledVector(new THREE.Vector3(0, 1, 0), 0.13 * s);
		this.selGroup.position.copy(label);
		updateLeaderLine(this.selLine, at, label);
	}

	/**
	 * Which controller is driving the interface this frame.
	 *
	 * Handover is by AIM, not by a setting: the active hand keeps control while its ray is on
	 * something, and the other takes over the moment it finds a target. A left-handed student
	 * just points, and never has to discover a handedness option. Falls back to whichever
	 * controller is tracked when only one is.
	 */
	activeController(controllers) {
		const R = controllers?.right?.raySpace?.visible ? controllers.right : null;
		const L = controllers?.left?.raySpace?.visible ? controllers.left : null;
		if (!R || !L) return R || L;
		const last = this.lastHand === 'left' ? L : R;
		const other = last === R ? L : R;
		if (this.aimFindsTarget(last)) return last;
		if (this.aimFindsTarget(other)) {
			this.lastHand = other === R ? 'right' : 'left';
			return other;
		}
		return last;
	}

	/** Hand to use, as a name, for callers that need the side rather than the controller. */
	activeHand(controllers) {
		const c = this.activeController(controllers);
		if (!c) return null;
		return c === controllers?.left ? 'left' : 'right';
	}

	/** Aim this controller's ray and report whether it is on anything interactive. */
	aimFindsTarget(c) {
		if (!this.setRayFrom(c)) return false;
		if (this.video.isOpen)
			return !!(
				this.video.pickClose(this.ray) ||
				this.video.pickMute(this.ray) ||
				this.video.pickScrub(this.ray) ||
				this.video.pickPanel(this.ray)
			);
		if (this.continueBtn.visible && this.ray.intersectObject(this.continueBtn.userData.plate, false).length)
			return true;
		if (this.pickNav(this.ray)) return true;
		if (this.quiz && this.pickQuiz(this.ray)) return true;
		if (this.callouts.length && this.pickCallout(this.ray)) return true;
		return this.model.hitList(this.ray, this.pickOpts()).length > 0;
	}

	/** Point this.ray down a controller's -Z. Returns false when that hand is not tracked. */
	setRayFrom(c) {
		if (!c?.raySpace?.visible) return false;
		const o = c.raySpace.getWorldPosition(new THREE.Vector3());
		const d = new THREE.Vector3(0, 0, -1).applyQuaternion(c.raySpace.getWorldQuaternion(new THREE.Quaternion()));
		this.ray.set(o, d);
		return true;
	}

	hoverSay(msg) {
		if (!this.hoverLine) {
			// Sized and placed from the same layout numbers as the card, so the hover name stays
			// the same apparent size on the lens and never lands on the anatomy.
			const w = this.ui.panelW;
			this.hoverLine = makeText({
				fontSize: this.ui.feedText,
				maxWidth: w * 0.92,
				anchorX: 'center',
				anchorY: 'bottom',
				color: 0xffffff,
			});
			this.hoverLine.position.set(this.ui.panelX, this.ui.panelBottom - 0.022, this.ui.panelZ);
			this.root.add(this.hoverLine);
			this.uiParts.push(this.hoverLine);
		}
		this.hoverLine.text = msg;
		this.hoverLine.sync();
	}

	/**
	 * Is this part actually visible from where the student is standing right now?
	 * Casts only as far as the part itself, so anything hit nearer is genuinely in front of it.
	 * Used to turn a failed point into an anatomy lesson instead of a dead end: in an anterior
	 * view the atria sit BEHIND the ventricles, which is real anatomy, not a bug — and in a
	 * headset the student can fix it themselves by leaning or walking around the table.
	 */
	isHiddenFromEye(id, eye) {
		const c = this.model.center(id);
		const dir = c.clone().sub(eye);
		const dist = dir.length();
		if (dist < 1e-6) return false;
		const far = this.ray.far;
		this.ray.set(eye.clone(), dir.normalize());
		this.ray.far = dist - 0.004;
		const nearer = this.model.pick(this.ray);
		this.ray.far = far;
		return !!nearer && nearer !== id;
	}

	/** A trigger press on a part. This is where formative feedback is produced. */
	select(id) {
		// Any part press dismisses an open callout: the student has moved on to something else.
		if (id) this.closeCallout();
		if (id) this.showSelected(id);
		if (!id) {
			if (this.done) this.reset();
			return null;
		}
		const st = this.steps[this.i];
		const a = st?.action || {};

		if (a.flow) {
			const want = this.flowParts();
			const expect = want[this.flow.i];
			if (id === expect) {
				this.model.flash(id, 0x2f8f4f, 1);
				this.flow.i += 1;
				this.flow.misses = 0;
				const hop = this.nextWaypointAfter(this.flow.i);
				this.say(hop ? `${hop.label}` : `Good — ${this.partName(id)}.`, OK);
				if (this.flow.i < want.length) this.revealPathTo(want[this.flow.i]);
				if (this.flow.i >= want.length) {
					this.say(`Complete. And remember: the vessel that leaves for the lungs carries LOW-oxygen blood.`, OK);
					this.setContinueEnabled(true);
					this.fire('flow-complete');
				}
				return 'ok';
			}
			this.flow.misses += 1;
			this.model.flash(id, 0xa33A2A, 2);
			const prev = this.partName(want[Math.max(0, this.flow.i - 1)]);
			const eye = this.camera.getWorldPosition(new THREE.Vector3());
			if (this.isHiddenFromEye(expect, eye))
				// Real anatomy, self-serviceable: the atria sit behind the ventricles in the view a
				// student is given. Tell them the part is behind the heart so they move, instead of
				// letting them poke the same wall nine times.
				this.say(
					`You are pointing at the ${this.partName(id)}. The ${this.partName(expect)} is deeper in — ` +
						`blood reaches it from the lungs on the far side of the heart.`,
					BAD,
				);
			else if (this.flow.misses > 2) this.say(`This one is the ${this.partName(expect)}.`, BAD);
			else this.say(`That is the ${this.partName(id)}. Blood has just left the ${prev} — where does it go next?`, BAD);
			this.fire('flow-miss');
			return 'miss';
		}

		if (a.reassemble) {
			if (!this.find.asked) return null;
			if (id === this.find.asked) {
				this.model.assemble(id);
				this.model.flash(id, 0x2f8f4f, 1);
				this.find.queue.shift();
				this.fire('name-ok');
				this.nextAsk();
				return 'ok';
			}
			this.find.misses += 1;
			this.model.flash(id, 0xa33A2A, 2);
			const eye = this.camera.getWorldPosition(new THREE.Vector3());
			const want = this.find.asked;
			// Speak in student-facing sentences built from lesson vocab, never from a raw registry
			// field: interpolating spec.system produced "it is chamber." for a learner.
			if (this.isHiddenFromEye(want, eye))
				this.say(
					`The ${this.partName(want)} is on the far side of the heart from you — that is real ` +
						`anatomy, the atria sit behind the ventricles. Lean around the model and point at it.`,
					BAD,
				);
			else if (this.find.misses > 2) this.say(`The one you want is the ${this.partName(want)}. ${this.factFor(want)}`, BAD);
			else this.say(`That is the ${this.partName(id)}. Look for the ${this.partName(want)}.`, BAD);
			this.fire('name-miss');
			return 'miss';
		}

		// Exploring steps: naming on select is the lesson, not a test.
		this.say(`${this.partName(id)} — ${this.factFor(id)}`, MUTED);
		return 'info';
	}

	nextWaypointAfter(k) {
		const seq = this.data.flow.order;
		const partsSoFar = this.flowParts().slice(0, k);
		let seen = 0;
		for (const hop of seq) {
			if (hop.kind === 'part') {
				seen += 1;
				if (seen > partsSoFar.length - 1) break;
			}
		}
		const idx = seq.findIndex((h) => h.kind === 'waypoint' && !this._lit?.has(h.label));
		if (idx < 0) return null;
		this._lit = this._lit || new Set();
		const hop = seq[idx];
		this._lit.add(hop.label);
		return hop;
	}

	fire(kind) {
		if (this.onEvent) this.onEvent(kind);
	}

	/** Is the controller ray currently on the Continue plate? */
	pickButton(controllers) {
		const ct = this.activeController(controllers);
		if (!this.setRayFrom(ct)) return false;
		return this.ray.intersectObject(this.continueBtn.userData.plate, false).length > 0;
	}

	/**
	 * F3: size each controller's ray line to what it is pointing at and park the cursor dot on
	 * the hit. Only the active controller drives selection, so the other one shows a short,
	 * faint stub with no cursor — two full-length lines read as two pointers that both work.
	 */
	updatePointers(controllers, active, hitDist) {
		const idle = this.data.runtime?.rayIdleMetres ?? 1.5;
		for (const c of [controllers?.left, controllers?.right]) {
			if (!c?.rayLine) continue;
			const on = c === active;
			const len = on ? hitDist ?? idle : 0.15;
			c.rayLine.scale.z = len;
			c.rayLine.material.opacity = on ? (hitDist != null ? 0.85 : 0.45) : 0.2;
			c.cursor.visible = on && hitDist != null;
			c.cursor.position.z = -len;
		}
	}

	/** Per-frame: tweens, hover picking, label billboards. */
	update(dt, controllers) {
		for (const tw of this.tweens) {
			tw.t += dt;
			const k = Math.min(1, tw.t / tw.dur);
			const e = tw.ease === 'out' ? 1 - (1 - k) ** 3 : k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
			// The final frame lands on `to` exactly (e === 1), so the model never rests a float
			// hair away from its authored arrangement.
			this.model.setFactor(k >= 1 ? tw.to + this.extraSpread : tw.from + (tw.to - tw.from) * e + this.extraSpread);
		}
		this.tweens = this.tweens.filter((tw) => tw.t < tw.dur);
		this.model.stepHoming(dt);

		const camQ = this.camera.getWorldQuaternion(new THREE.Quaternion());
		// Panels and the Continue plate face the head. The plate sits ~0.4 m off-axis, and a fixed
		// tilt made it read edge-on at the edge of the Quest field of view.
		for (const head of this.uiParts) head.quaternion.copy(camQ);

		this.video.update(dt);
		// Let a primed Full Reset lapse on its own.
		if (this.resetArmed > 0) {
			this.resetArmed -= dt;
			if (this.resetArmed <= 0) {
				this.resetArmed = 0;
				this.syncResetLabel();
			}
		}
		this.updateGrab(controllers);
		if (this.callouts.length) this.placeCallouts();
		if (this.calloutHover != null) this.callouts[this.calloutHover].hover.quaternion.copy(camQ);

		const ct = this.activeController(controllers);
		let hitDist = null;
		if (this.setRayFrom(ct)) {
			// The clip owns the whole pick chain while it is up: everything else is behind an
			// opaque panel, and hovering a part the student cannot see is meaningless.
			if (this.video.isOpen) {
				const close = this.video.pickClose(this.ray);
				const mute = close ? null : this.video.pickMute(this.ray);
				const scrub = close || mute ? null : this.video.pickScrub(this.ray);
				const panel = close || mute || scrub ? null : this.video.pickPanel(this.ray);
				this.videoHover = close ? 'close' : mute ? 'mute' : scrub ? 'scrub' : null;
				this.setVideoBtn(this.video.closeBtn, this.videoHover === 'close');
				this.setVideoBtn(this.video.muteBtn, this.videoHover === 'mute');
				// Scrubbing is a HOLD, not a click, so it is driven here rather than from the
				// trigger handler. Once a drag starts the position comes from the track's PLANE,
				// so sweeping past the end of the bar keeps seeking instead of dropping the drag.
				const held = !!ct?.gamepad?.getButton?.(XR_BUTTONS.TRIGGER);
				if (this.video.scrubbing) {
					if (held) {
						const u = this.video.scrubUFromRay(this.ray);
						if (u != null) this.video.scrubTo(u);
					} else {
						this.video.endScrub();
					}
				} else if (held && scrub) {
					this.video.beginScrub(scrub.u);
				}
				this.hoverCallout(-1);
				this.hoverQuiz(null);
				this.hoverPart(null);
				this.updatePointers(controllers, ct, (close || mute || scrub || panel)?.distance ?? null);
				return;
			}
			this.videoHover = null;
			// While holding, hover is pinned to the held part: the ray sweeps across everything
			// as the arm moves, and re-picking would strobe the highlight and the name readout.
			if (this.grab) {
				this.updatePointers(controllers, ct, null);
				return;
			}
			// Priority: Continue plate, then callout dots, then parts. A dot sits on the surface
			// of its part, so without this order the part would always shadow it.
			const btn = this.continueBtn.visible
				? this.ray.intersectObject(this.continueBtn.userData.plate, false)[0]
				: null;
			const nav = btn ? null : this.pickNav(this.ray);
			this.hoverNav(nav?.kind ?? null);
			const qz = btn || nav ? null : this.pickQuiz(this.ray);
			const dot = btn || qz ? null : this.pickCallout(this.ray);
			if (qz) this.hoverQuiz(qz.plate.userData.choice);
			else this.hoverQuiz(null);
			if (btn) {
				this.hoverCallout(-1);
				this.hoverPart(null);
				hitDist = btn.distance;
			} else if (nav) {
				this.hoverCallout(-1);
				this.hoverPart(null);
				hitDist = nav.distance;
			} else if (qz) {
				this.hoverCallout(-1);
				this.hoverPart(null);
				hitDist = qz.distance;
			} else if (dot) {
				this.hoverCallout(dot.index);
				this.hoverPart(null);
				hitDist = dot.distance;
			} else {
				this.hoverCallout(-1);
				const hits = this.model.hitList(this.ray, this.pickOpts());
				this.hoverPart(this.model.idOfHit(hits[0]) ?? null);
				if (hits[0]) hitDist = hits[0].distance;
			}
		}
		this.updatePointers(controllers, ct, hitDist);

		if (this.calloutOpen != null) {
			// Leader from the card's nearest bottom corner back to the dot, so the reader can see
			// which structure the card is about even after the parts have moved.
			const c = this.callouts[this.calloutOpen];
			const from = c.dot.getWorldPosition(new THREE.Vector3());
			const pg = this.calloutPanel.group;
			const toward = this.ui.calloutX > this.ui.panelX ? -1 : 1;
			const corner = new THREE.Vector3((toward * this.ui.panelW) / 2, -(this.calloutPanel.height || 0.04), 0);
			pg.updateMatrixWorld();
			updateLeaderLine(this.calloutLine, from, pg.localToWorld(corner));
		}

		if (this.selGroup.visible) {
			this.placeSelected();
			this.selLabel.quaternion.copy(camQ);
		}

		if (this.labelGroup.visible) this.updateLabels();

		if (this.waypointGroup.visible) {
			// The parts keep moving while the student explodes the model, so schematic markers are
			// re-anchored every frame instead of once at step entry.
			this.placeWaypoints();
			const q = this.camera.getWorldQuaternion(new THREE.Quaternion());
			for (const g of this.waypointGroup.children) g.userData.lab.quaternion.copy(q);
		}
	}

	/**
	 * Labels fan out on a ring around the model with a guaranteed minimum angular gap. Pointing a
	 * label straight outward from its own part is not enough: chambers and valves share azimuths,
	 * and in a screenshot review eight names piled into one unreadable blob at the model centre.
	 */
	/**
	 * Place a label on the sphere centred on the student's eye, at the given view angles. Working in
	 * the student's own azimuth/elevation is the only way to guarantee the gaps they actually see:
	 * spacing measured around the model centre collapsed from a 26-degree intent to 1.2 degrees on
	 * the retina, because perspective compresses a ring that sits between the eye and the target.
	 */
	static viewPoint(eye, az, el, r) {
		const cy = Math.cos(el);
		return new THREE.Vector3(eye.x + Math.sin(az) * cy * r, eye.y + Math.sin(el) * r, eye.z - Math.cos(az) * cy * r);
	}

	/** Push view angles apart until every pair clears the minimum azimuth and elevation gap. */
	static spreadAngles(items, azGap, elGap) {
		for (let pass = 0; pass < items.length + 2; pass++) {
			items.sort((a, b) => a.az - b.az);
			for (let i = 1; i < items.length; i++) if (items[i].az - items[i - 1].az < azGap) items[i].az = items[i - 1].az + azGap;
			items.sort((a, b) => a.el - b.el);
			for (let i = 1; i < items.length; i++) if (items[i].el - items[i - 1].el < elGap) items[i].el = items[i - 1].el + elGap;
		}
		return items;
	}

	updateLabels() {
		const camQ = this.camera.getWorldQuaternion(new THREE.Quaternion());
		const eye = this.camera.getWorldPosition(new THREE.Vector3());
		const items = [];
		for (const lab of this.labelGroup.children) {
			const id = lab.userData.id;
			const c = this.model.center(id);
			const d = c.clone().sub(eye);
			const r = Math.max(0.3, d.length() + 0.12);
			items.push({ lab, c, anchorR: this.model.radius(id), r, az: Math.atan2(d.x, -d.z), el: Math.atan2(d.y, Math.hypot(d.x, d.z)) });
		}
		// Alternate two shells so neighbouring names do not crowd the same arc.
		items.sort((a, b) => a.az - b.az).forEach((it, i) => (it.r += i % 2 ? 0.1 : 0));
		const mean = (k) => items.reduce((s, it) => s + it[k], 0) / items.length;
		const wantAz = mean('az'), wantEl = mean('el');
		Lesson.spreadAngles(items, THREE.MathUtils.degToRad(12), THREE.MathUtils.degToRad(6));
		// Relaxation only ever pushes upward, which slides the whole fan off to one side. Put its
		// centre back on the parts so the labels straddle the model instead of trailing off it.
		const dAz = mean('az') - wantAz, dEl = mean('el') - wantEl;
		for (const it of items) {
			it.az -= dAz;
			it.el = THREE.MathUtils.clamp(it.el - dEl, THREE.MathUtils.degToRad(-25), THREE.MathUtils.degToRad(25));
		}
		for (const it of items) {
			const to = Lesson.viewPoint(eye, it.az, it.el, it.r);
			it.lab.position.copy(to);
			it.lab.quaternion.copy(camQ);
			const dir = to.clone().sub(it.c).normalize();
			updateLeaderLine(it.lab.userData.line, it.c.clone().addScaledVector(dir, it.anchorR), to);
		}
	}

	state() {
		const st = this.steps[this.i];
		return {
			step: this.i + 1,
			stepId: st?.id,
			level: this.level,
			eyeY: +this.ui.eyeY.toFixed(3),
			factor: +this.model.factor.toFixed(3),
			extraSpread: +this.extraSpread.toFixed(2),
			flow: this.flow,
			find: { asked: this.find.asked, left: this.find.queue.length },
			hover: this.hover,
			badge: this.badgeKind ?? null,
			grab: this.grab ? { id: this.grab.id, hand: this.grab.hand } : null,
			nav: { hover: this.navHover ?? null, resetArmed: +Math.max(0, this.resetArmed).toFixed(1) },
			moved: this.model.movedIds().length,
			video: this.video ? { ...this.video.state(), hover: this.videoHover ?? null } : null,
			quiz: this.quiz ? { q: this.quiz.i + 1, of: this.quiz.total, score: this.quiz.score, answered: this.quiz.answered } : null,
			callout: { hover: this.callouts[this.calloutHover]?.spec.id ?? null, open: this.callouts[this.calloutOpen]?.spec.id ?? null, shown: this.callouts.filter((c) => c.marker.visible).length },
			ready: !!this.continueOn,
			done: this.done,
			drawCalls: this.renderer?.info?.render?.calls,
			tris: this.renderer?.info?.render?.triangles,
		};
	}
}
