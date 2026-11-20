/**
 * Lesson runtime: reads the lesson JSON and runs it in world space. Every interaction maps to a
 * learning outcome, and every choice the student makes gets an immediate, specific response.
 * Nothing is stored — the classroom rule is formative feedback only, no records, no accounts.
 */
import * as THREE from 'three';
import { Panel, makeButton, makeLabel, makeLeaderLine, makeText, updateLeaderLine } from './text.js';
import { VideoScreen } from './video.js';

const OK = 0x8fe3a0;
const BAD = 0xff9a8a;
const MUTED = 0xb9c7d4;

/** Hover/select names must draw over neighbouring anatomy, not vanish inside it. */
function drawOnTop(label, line) {
	const text = label.userData.text;
	text.material = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false });
	text.renderOrder = 20;
	line.material.transparent = true;
	line.material.depthTest = false;
	line.material.depthWrite = false;
	line.renderOrder = 19;
}

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
		};
		this.ui = { eyeY: u.eyeHeightMetres ?? 1.45 };
		this.planUi();

		this.t = new THREE.Vector3();
		this.ray = new THREE.Raycaster();
		this.hover = null;
		this.grab = null;
		this.lastHand = 'right';
		this.selId = null;
		this.selGroup = new THREE.Group();
		this.selLabel = makeLabel((data.runtime || {}).labelTextHeightMetres ?? 0.019, 0xffffff);
		this.selLine = makeLeaderLine();
		this.selGroup.add(this.selLabel);
		this.selGroup.visible = false;
		this.selLine.visible = false;
		this.root.add(this.selGroup, this.selLine);
		this.hovId = null;
		this.hovGroup = new THREE.Group();
		this.hovLabel = makeLabel((data.runtime || {}).labelTextHeightMetres ?? 0.019, 0xffffff);
		this.hovLine = makeLeaderLine();
		this.hovGroup.add(this.hovLabel);
		this.hovGroup.visible = false;
		this.hovLine.visible = false;
		this.root.add(this.hovGroup, this.hovLine);
		drawOnTop(this.hovLabel, this.hovLine);
		drawOnTop(this.selLabel, this.selLine);
		this.flow = { i: 0, misses: 0 };
		this.find = { queue: [], asked: null, misses: 0 };
		this.done = false;

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
	}

	buildUI() {
		const { panelW, panelZ, promptText, feedText, btnX, btnY, btnW, eyeY } = this.ui;
		// One panel carries the step counter inside it. A separate floating counter line printed
		// straight through the prompt panel and read as doubled text.
		this.prompt = new Panel({ width: panelW, fontSize: promptText });
		this.feedback = new Panel({ width: panelW, fontSize: feedText });
		// troika measures wrapped text asynchronously, so the measured height arrives after set().
		// Re-anchor the stack each time a panel is remeasured, or the backdrop keeps the previous
		// prompt's height and the extra lines spill off it onto the model.
		this.prompt.onfit = () => this.relayout();
		this.feedback.onfit = () => this.relayout();
		this.prompt.group.position.set(this.ui.panelX, this.ui.panelBottom, panelZ);
		this.feedback.group.position.set(this.ui.panelX, this.ui.panelBottom, panelZ);
		// The plate is sized from the same angular spec as everything else, so it stays the same
		// apparent size on the lens when the card moves closer to or further from the face.
		this.continueBtn = makeButton({ label: 'Continue  (trigger)', width: btnW, height: btnW * 0.26 });
		this.continueBtn.position.set(btnX, btnY, panelZ);
		this.playBtn = makeButton({ label: 'Play video', width: btnW, height: btnW * 0.26 });
		this.playBtn.position.set(-btnX, btnY, panelZ);
		this.root.add(this.prompt.group, this.feedback.group, this.continueBtn, this.playBtn);

		this.quiz = null;
		this._quizDone = false;
		this.buildQuizHud();

		// Panels face the reader's eye height here, then track the head in update(). The Continue
		// plate sits well off-axis, so a fixed tilt made it read edge-on at the frame edge.
		this.uiParts = [this.prompt.group, this.feedback.group, this.continueBtn, this.playBtn];
		for (const head of this.uiParts) head.lookAt(0, eyeY, 0);

		// World-locked lecture clip. Not tied to a step: the Play video plate is always available.
		this.video = new VideoScreen({
			camera: this.camera,
			parent: this.player,
			videos: this.data.videos || {},
			runtime: this.data.runtime || {},
		});
		this.videoHover = null;
	}

	/**
	 * Head-locked quiz overlay. Parent is the XR camera so the card inherits yaw/pitch/roll
	 * with zero lag — no world position, no billboard copy, no lerp. 0.6 m in front of the
	 * eye (inside 0.5–0.7 m); camera near is 0.1 m so it does not clip. Type is sized for
	 * Quest 2 (~18.5 px/deg): heading 32 px, body 24 px.
	 */
	buildQuizHud() {
		const dist = 0.6;
		const px = (pxSize) => dist * Math.tan(((pxSize / 18.5) * Math.PI) / 180);
		this.quizDist = dist;
		this.quizHud = new THREE.Group();
		this.quizHud.position.set(0, 0, -dist);
		this.quizHud.visible = false;
		this.camera.add(this.quizHud);

		const cardW = 0.36;
		this.quizBack = new THREE.Mesh(
			new THREE.PlaneGeometry(cardW, 0.32),
			new THREE.MeshBasicMaterial({
				color: 0x101418,
				transparent: true,
				opacity: 0.92,
				depthTest: false,
				depthWrite: false,
			}),
		);
		this.quizBack.position.z = -0.006;
		this.quizBack.renderOrder = 30;
		this.quizBack.raycast = () => {};

		this.quizTitle = makeText({
			fontSize: px(32),
			maxWidth: cardW - 0.04,
			anchorX: 'center',
			anchorY: 'bottom',
			align: 'center',
			color: 0xffffff,
		});
		this.quizBody = makeText({
			fontSize: px(24),
			maxWidth: cardW - 0.04,
			anchorX: 'center',
			anchorY: 'top',
			align: 'center',
			color: 0xf2f2f2,
		});
		this.quizTitle.position.set(0, 0.1, 0);
		this.quizBody.position.set(0, 0.088, 0);
		this.quizHud.add(this.quizBack, this.quizTitle, this.quizBody);

		this.quizBtns = [];
		const bw = 0.155;
		const bh = 0.042;
		for (let i = 0; i < 4; i++) {
			const b = makeButton({ label: ' ', width: bw, height: bh, fontSize: px(24) });
			b.userData.plate.material = new THREE.MeshBasicMaterial({ color: 0x2f6fb3, depthTest: false, depthWrite: false });
			b.userData.plate.renderOrder = 31;
			b.visible = false;
			this.quizHud.add(b);
			this.quizBtns.push(b);
		}
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
			drawOnTop(lab, lab.userData.line);
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
			drawOnTop(lab, { material: { transparent: true, depthTest: false, depthWrite: false }, renderOrder: 19 });
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

		this.grabEnd();
		this._leave = null;
		this.hideQuiz();
		this._quizDone = false;
		this.model.returnMoved();
		this.clearSelected();
		this.model.clearLook();
		// `labels` is either 'core' (every pointable part), 'none', or an explicit id list. Step 2
		// names only the four chambers because that is what the step asks the student to do, and
		// eight full anatomical names will not fit on one arc: a name like "Right cardiac atrium"
		// is about 21 degrees wide at label distance, so more than ~5 of them overlap no matter how
		// they are fanned. Everything else stays available by pointing at it.
		const labelIds = a.labels === 'core' ? this.data.tiers.core : Array.isArray(a.labels) ? a.labels : null;
		this.labelGroup.visible = !!labelIds;
		this.waypointGroup.visible = !!a.flow;
		if (labelIds) this.buildLabels(labelIds);
		this.hoverPart(null);

		if (a.isolate) this.model.isolate(a.isolate);
		if (a.ghost) this.model.ghost(a.ghost);
		if (a.flow) {
			this.flow = { i: 0, misses: 0 };
			this.buildWaypoints();
			const first = this.flowParts()[0];
			if (first) this.revealPathTo(first);
		}
		if (a.reassemble) {
			this.find = { queue: this.shuffle(this.data.tiers.core.filter((id) => this.model.parts.has(id))), asked: null, misses: 0 };
			this.nextAsk();
		}

		const target = Array.isArray(a.explode) ? a.explode[1] : a.explode ?? 0;
		if (a.reassemble) this.model.scatter();
		this.tweenFactor(target, a.explode === 0 ? 0.6 : 5.0);

		this.prompt.set(`Step ${this.i + 1} of ${this.steps.length} · ${st.title}\n\n${st.verb.toUpperCase()} — ${this.textOf(st.prompt)}`);
		this.say(this.misconceptionFor(st.id));
		this.setContinueEnabled(!a.flow && !a.reassemble);
		this.relayout();
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
		this.relayout();
	}

	/** Explicit wipe. `say('')` cannot do this: `say` ignores empty messages on purpose. */
	clearSay() {
		this.feedback.set('', MUTED);
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
		this.panelBottomY = b;
	}

	setContinueEnabled(on) {
		this.continueOn = on;
		this.continueBtn.userData.plate.material.color.setHex(on ? 0x2f6fb3 : 0x3a4550);
		this.continueBtn.userData.caption.color = on ? 0xffffff : 0x8a97a3;
		this.continueBtn.userData.caption.sync();
	}

	tweenFactor(to, dur) {
		this.tweens = this.tweens.filter((tw) => !tw.factor);
		if (Math.abs(this.model.factor - to) < 1e-4) {
			this.model.setFactor(to);
			return;
		}
		this.tweens.push({ factor: true, from: this.model.factor, to, t: 0, dur });
	}

	next() {
		if (!this.continueOn) return false;
		if (this._leave) return false;
		if (this.quiz) return false;
		const qIndex = this.steps[this.i]?.action?.quiz;
		if (Number.isInteger(qIndex) && !this._quizDone) {
			this.showQuiz(qIndex);
			return true;
		}
		this.beginLeave(() => {
			if (this.i >= this.steps.length - 1) this.finish();
			else this.enterStep(this.i + 1);
		});
		return true;
	}

	showQuiz(n) {
		const item = (this.data.quiz || [])[n];
		if (!item) return false;
		this.quiz = { n, item };
		this.setContinueEnabled(false);
		this.continueBtn.visible = false;
		this.playBtn.visible = false;
		this.prompt.group.visible = false;
		this.feedback.group.visible = false;
		this.labelGroup.visible = false;
		this.lineGroup.visible = false;
		this.waypointGroup.visible = false;
		this.showHoverName(null);
		this.clearSelected();
		const title = item.title || `Quiz ${n + 1}`;
		this.quizTitle.text = title;
		this.quizTitle.sync();
		this.quizBody.text = item.q;
		this.quizBody.sync();
		this.placeQuizBtns();
		item.choices.forEach((c, i) => {
			const b = this.quizBtns[i];
			if (!b) return;
			b.userData.caption.text = c;
			b.userData.caption.sync();
			b.visible = true;
		});
		this.quizHud.visible = true;
		return true;
	}

	/** Choice plates in camera-local space, under the question, never in world space. */
	placeQuizBtns() {
		const bw = 0.155;
		const bh = 0.042;
		const gap = 0.012;
		this.quizBtns.forEach((b, i) => {
			const col = i % 2;
			const row = Math.floor(i / 2);
			b.position.set((col ? 1 : -1) * (bw / 2 + gap), -0.055 - row * (bh + gap), 0.002);
		});
	}

	hideQuiz() {
		this.quiz = null;
		this.quizHud.visible = false;
		for (const b of this.quizBtns || []) b.visible = false;
		this.continueBtn.visible = true;
		this.playBtn.visible = true;
		this.prompt.group.visible = true;
		this.feedback.group.visible = true;
		const a = this.steps[this.i]?.action || {};
		this.labelGroup.visible = a.labels === 'core' || Array.isArray(a.labels);
		this.lineGroup.visible = this.labelGroup.visible;
		this.waypointGroup.visible = !!a.flow;
	}

	answerQuiz(i) {
		if (!this.quiz) return false;
		const { item, n } = this.quiz;
		if (i === item.answer) {
			this.say(`Quiz ${n + 1} — correct. ${item.why}`, OK);
			this._quizDone = true;
			this.hideQuiz();
			this.beginLeave(() => {
				if (this.i >= this.steps.length - 1) this.finish();
				else this.enterStep(this.i + 1);
			});
			return true;
		}
		this.say(`Quiz ${n + 1} — not that one. ${item.why}`, BAD);
		return false;
	}

	beginLeave(done) {
		this.grabEnd();
		this.setContinueEnabled(false);
		const fromMoved = new Map();
		for (const [id, p] of this.model.parts) {
			fromMoved.set(id, {
				moved: p.moved ? p.moved.clone() : null,
				quat: p.mesh.quaternion.clone(),
			});
			p.snapFrom = null;
		}
		this._leave = { t: 0, dur: 1.4, from: this.model.factor, fromMoved, done };
	}

	prev() {
		if (this.i > 0) this.enterStep(this.i - 1);
	}

	finish() {
		this.done = true;
		this.grabEnd();
		this.model.returnMoved();
		this.clearSelected();
		this.showHoverName(null);
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
		this.flow = { i: 0, misses: 0 };
		this.find = { queue: [], asked: null, misses: 0 };
		this.tweens = [];
		this._lit = null;
		this.grabEnd();
		this.model.returnMoved();
		this.clearSelected();
		if (this.video?.isOpen) this.closeVideo();
		if (this.hover) this.model.highlight(this.hover, false);
		this.hover = null;
		this.showHoverName(null);
		this.clearSay();
		this.model.clearLook();
		this.model.scatter();
		this.model.setFactor(0);
		this.enterStep(0);
	}

	hoverPart(id) {
		if (this.hover === id) return;
		if (this.hover) this.model.highlight(this.hover, false);
		this.hover = id;
		if (id) this.model.highlight(id, true);
		this.showHoverName(id);
	}

	hoverNamesAllowed() {
		return !!this.steps[this.i]?.action?.hoverNames;
	}

	hasStepLabel(id) {
		return this.labelGroup.visible && this.labelGroup.children.some((c) => c.userData.id === id);
	}

	/** Pop the name up at the part under the pointer, or take it down (`id` null). */
	showHoverName(id) {
		const show =
			!!id &&
			id !== this.selId &&
			this.hoverNamesAllowed() &&
			!!this.model.parts.get(id) &&
			!this.hasStepLabel(id);
		this.hovId = show ? id : null;
		this.hovGroup.visible = show;
		this.hovLine.visible = show;
		if (!show) return false;
		this.hovLabel.userData.text.text = this.partName(id);
		this.hovLabel.userData.text.sync();
		this.placePartLabel(id, this.hovGroup, this.hovLine);
		return true;
	}

	/**
	 * Put a name just above the part on the reader's side, with a leader back to its centre.
	 * Straight-above lands inside a neighbour once the heart is exploded.
	 */
	placePartLabel(id, group, line) {
		const at = this.model.center(id);
		const r = this.model.radius(id);
		const eye = this.camera.getWorldPosition(this._lblEye || (this._lblEye = new THREE.Vector3()));
		const toEye = (this._lblDir || (this._lblDir = new THREE.Vector3())).copy(eye).sub(at);
		const d = toEye.length() || 1;
		toEye.multiplyScalar(1 / d);
		const label = at.clone().addScaledVector(toEye, Math.min(r + 0.02, d * 0.4));
		label.y += r * 0.6 + 0.045;
		group.position.copy(label);
		updateLeaderLine(line, at, label);
	}

	showSelected(id) {
		if (!id || !this.model.parts.get(id) || this.hasStepLabel(id)) return this.clearSelected();
		this.selId = id;
		this.selLabel.userData.text.text = this.partName(id);
		this.selLabel.userData.text.sync();
		this.selGroup.visible = true;
		this.selLine.visible = true;
		this.placePartLabel(id, this.selGroup, this.selLine);
		this.showHoverName(this.hover);
		return true;
	}

	clearSelected() {
		this.selId = null;
		this.selGroup.visible = false;
		this.selLine.visible = false;
		this.showHoverName(this.hover);
		return false;
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
		if (!id) {
			if (this.done) this.reset();
			return null;
		}
		this.showSelected(id);
		const st = this.steps[this.i];
		const a = st?.action || {};

		if (a.flow) {
			const want = this.flowParts();
			const expect = want[this.flow.i];
			if (id === expect) {
				this.model.flash(id, 0x2f8f4f);
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
			this.model.flash(id, 0xa33A2A);
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
				this.model.flash(id, 0x2f8f4f);
				this.find.queue.shift();
				this.fire('name-ok');
				this.nextAsk();
				return 'ok';
			}
			this.find.misses += 1;
			this.model.flash(id, 0xa33A2A);
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

	defaultVideoId() {
		return Object.keys(this.data.videos || {})[0] || null;
	}

	videoMaskTargets() {
		return [
			this.prompt.group,
			this.feedback.group,
			this.continueBtn,
			this.playBtn,
			this.labelGroup,
			this.lineGroup,
			this.waypointGroup,
			this.hovGroup,
			this.hovLine,
			this.selGroup,
			this.selLine,
			this.model.group,
			this.quizHud,
		];
	}

	hideForVideo() {
		this._maskBackup = this.videoMaskTargets().map((o) => [o, o.visible]);
		for (const o of this.videoMaskTargets()) o.visible = false;
	}

	restoreAfterVideo() {
		if (!this._maskBackup) return;
		for (const [o, vis] of this._maskBackup) o.visible = vis;
		this._maskBackup = null;
	}

	openVideo(id, at) {
		const clip = id || this.defaultVideoId();
		if (!this.video.open(clip, at)) return false;
		this.hideForVideo();
		this.fire('video-open', clip);
		return true;
	}

	closeVideo() {
		if (!this.video.close()) return false;
		this.restoreAfterVideo();
		this.videoHover = null;
		this.fire('video-close');
		return true;
	}

	/** Trigger while the clip is up: Close, Mute, or swallow presses on the panel. */
	pressVideo() {
		if (!this.video.isOpen) return false;
		if (this.videoHover === 'close') return this.closeVideo();
		if (this.videoHover === 'play') return this.video.play();
		if (this.videoHover === 'pause') return this.video.pause();
		if (this.videoHover === 'scrub') {
			const u = this.video.pickScrub(this.ray)?.u;
			if (u != null) this.video.seekToFraction(u);
			return true;
		}
		return true;
	}

	setVideoBtn(btn, on) {
		const plate = btn?.userData?.plate;
		if (plate) plate.material.color.setHex(on ? 0x4a90d9 : 0x2f6fb3);
	}

	/**
	 * Squeeze pressed: take hold of whatever the pointer is on.
	 * Trigger stays select/advance so the two verbs never collide.
	 */
	grabStart(hand, controllers, via = 'squeeze') {
		if (this.grab) return false;
		if (this.video?.isOpen) return false;
		const id = this.hover;
		if (!id) return false;
		const ct = controllers?.[hand];
		if (!ct?.gripSpace) return false;
		const start = this.model.beginGrab(id);
		if (!start) return false;
		const handWorld = ct.gripSpace.getWorldPosition(new THREE.Vector3());
		const handQuat = ct.gripSpace.getWorldQuaternion(new THREE.Quaternion());
		this.grab = {
			id,
			hand,
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

	grabEnd(hand, via) {
		if (!this.grab) return false;
		if (hand && this.grab.hand !== hand) return false;
		if (via && this.grab.via !== via) return false;
		const id = this.grab.id;
		this.model.endGrab(id);
		this.model.highlight(id, false);
		this.grab = null;
		if (this.steps[this.i]?.id === 's5-retrieve') this.model.scheduleSnap(id, 5, 1.8);
		this.fire('grab-end', id);
		return true;
	}

	/** Per-frame: drive the held part from the grip pose. */
	updateGrab(controllers) {
		if (!this.grab) return;
		const ct = controllers?.[this.grab.hand];
		if (!ct?.gripSpace?.visible) {
			this.grabEnd();
			return;
		}
		const g = this.grab;
		const handWorld = ct.gripSpace.getWorldPosition(this.t).clone();
		const handQuat = ct.gripSpace.getWorldQuaternion(new THREE.Quaternion());
		const delta = handQuat.clone().multiply(g.handQuat0Inv);
		const pos = handWorld.add(g.offset.clone().applyQuaternion(delta));
		const quat = delta.clone().multiply(g.partQuat0);
		this.model.setGrabWorld(g.id, pos, quat);
	}

	activeHand(controllers) {
		if (controllers?.[this.lastHand]?.raySpace?.visible) return this.lastHand;
		if (controllers?.right?.raySpace?.visible) return 'right';
		if (controllers?.left?.raySpace?.visible) return 'left';
		return this.lastHand;
	}

	/** Aim this.ray along a controller. */
	aim(ct) {
		if (!ct?.raySpace?.visible) return false;
		const o = ct.raySpace.getWorldPosition(new THREE.Vector3());
		const d = new THREE.Vector3(0, 0, -1).applyQuaternion(ct.raySpace.getWorldQuaternion(new THREE.Quaternion()));
		this.ray.set(o, d);
		return true;
	}

	uiFromRay() {
		if (this.continueBtn.visible && this.ray.intersectObject(this.continueBtn.userData.plate, false).length)
			return 'continue';
		if (this.playBtn.visible && this.ray.intersectObject(this.playBtn.userData.plate, false).length) return 'play';
		if (this.quiz) {
			for (let i = 0; i < this.quizBtns.length; i++) {
				const b = this.quizBtns[i];
				if (b.visible && this.ray.intersectObject(b.userData.plate, false).length) return `quiz-${i}`;
			}
		}
		return null;
	}

	/** Hit under the current this.ray: UI plate, video control, or anatomy part. */
	probe() {
		if (this.video?.isOpen) {
			const close = this.video.pickClose(this.ray);
			const play = this.video.pickPlay(this.ray);
			const pause = this.video.pickPause(this.ray);
			const scrub = this.video.pickScrub(this.ray);
			const panel = this.video.pickPanel(this.ray);
			const ui = close ? 'close' : play ? 'play' : pause ? 'pause' : scrub ? 'scrub' : panel ? 'panel' : null;
			const dist = close?.distance ?? play?.distance ?? pause?.distance ?? scrub?.distance ?? panel?.distance ?? null;
			return { dist, ui, partId: null };
		}
		const ui = this.uiFromRay();
		if (ui === 'continue') {
			const hit = this.ray.intersectObject(this.continueBtn.userData.plate, false)[0];
			return { dist: hit?.distance ?? null, ui, partId: null };
		}
		if (ui === 'play') {
			const hit = this.ray.intersectObject(this.playBtn.userData.plate, false)[0];
			return { dist: hit?.distance ?? null, ui, partId: null };
		}
		if (ui && ui.startsWith('quiz-')) {
			const b = this.quizBtns[+ui.slice(5)];
			const hit = b ? this.ray.intersectObject(b.userData.plate, false)[0] : null;
			return { dist: hit?.distance ?? null, ui, partId: null };
		}
		const hits = this.model.hitList(this.ray, this.pickOpts());
		return { dist: hits[0]?.distance ?? null, ui: null, partId: this.model.idOfHit(hits[0]) ?? null };
	}

	/** Which UI plate the given hand (or last aiming hand) is on. */
	pickUi(controllers, hand) {
		const h = hand || this.lastHand;
		const ct = controllers?.[h] || controllers?.right || controllers?.left;
		if (!this.aim(ct)) return null;
		return this.uiFromRay();
	}

	/** Is the controller ray currently on the Continue plate? */
	pickButton(controllers) {
		return this.pickUi(controllers) === 'continue';
	}

	/**
	 * Both controllers get a full ray and a cursor dot at the tip. An idle stub with no
	 * cursor on the off hand reads as a dead pointer.
	 */
	updatePointers(controllers, active, hitDist, perHand) {
		const idle = this.data.runtime?.rayIdleMetres ?? 1.5;
		for (const hand of ['left', 'right']) {
			const c = controllers?.[hand];
			if (!c?.rayLine) continue;
			const own = perHand?.[hand]?.dist;
			const on = c === active;
			const len = own ?? (on ? hitDist : null) ?? idle;
			c.rayLine.scale.z = len;
			c.rayLine.material.opacity = on ? 0.85 : 0.5;
			c.cursor.visible = true;
			c.cursor.position.z = -len;
		}
	}

	/** Per-frame: tweens, hover picking, label billboards. */
	update(dt, controllers) {
		if (!this._leave) {
			for (const tw of this.tweens) {
				tw.t += dt;
				const k = Math.min(1, tw.t / tw.dur);
				const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
				this.model.setFactor(tw.from + (tw.to - tw.from) * e);
			}
			this.tweens = this.tweens.filter((tw) => tw.t < tw.dur);
		}

		if (this._leave) {
			const lv = this._leave;
			lv.t += dt;
			const k = Math.min(1, lv.t / lv.dur);
			const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
			this.model.setFactor(lv.from * (1 - e));
			for (const [id, rec] of lv.fromMoved) {
				const p = this.model.parts.get(id);
				if (!p) continue;
				p.moved = rec.moved ? rec.moved.clone().multiplyScalar(1 - e) : null;
				if (p.homeQuat) p.mesh.quaternion.slerpQuaternions(rec.quat, p.homeQuat, e);
				p.turned = true;
			}
			this.model.apply();
			if (k >= 1) {
				this.model.returnMoved();
				const done = lv.done;
				this._leave = null;
				done?.();
			}
		} else {
			this.model.tickSnaps(dt);
		}

		if (this.video?.isOpen) this.video.update(dt);

		const camQ = this.camera.getWorldQuaternion(new THREE.Quaternion());
		// Panels and the Continue plate face the head. The plate sits ~0.4 m off-axis, and a fixed
		// tilt made it read edge-on at the edge of the Quest field of view.
		for (const head of this.uiParts) head.quaternion.copy(camQ);

		const perHand = {};
		let best = null;
		for (const hand of ['right', 'left']) {
			const c = controllers?.[hand];
			if (!this.aim(c)) continue;
			const hit = this.probe();
			perHand[hand] = hit;
			if (hit.dist != null && (!best || hit.dist < best.dist)) best = { hand, c, ...hit };
		}
		const activeHand = best?.hand || this.activeHand(controllers);
		if (best?.hand) this.lastHand = best.hand;
		const ct = controllers?.[activeHand];
		const hit = perHand[activeHand] || {};
		const hitDist = hit.dist ?? null;
		if (this.video?.isOpen) {
			this.hoverPart(null);
			this.videoHover = hit.ui ?? null;
			this.setVideoBtn(this.video.closeBtn, this.videoHover === 'close');
			this.setVideoBtn(this.video.playCtl, this.videoHover === 'play');
			this.setVideoBtn(this.video.pauseCtl, this.videoHover === 'pause');
			if (this.video.scrubbing && this.aim(ct)) {
				const u = this.video.scrubUFromRay(this.ray);
				if (u != null) this.video.scrubTo(u);
			}
		} else if (hit.ui) {
			this.hoverPart(null);
		} else {
			this.hoverPart(this.grab ? this.grab.id : hit.partId ?? null);
		}
		this.updatePointers(controllers, ct, hitDist, perHand);
		this.updateGrab(controllers);

		if (this.hovGroup.visible && this.hovId) {
			this.placePartLabel(this.hovId, this.hovGroup, this.hovLine);
			this.hovLabel.quaternion.copy(camQ);
		}
		if (this.selGroup.visible && this.selId) {
			this.placePartLabel(this.selId, this.selGroup, this.selLine);
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
			factor: +this.model.factor.toFixed(3),
			flow: this.flow,
			find: { asked: this.find.asked, left: this.find.queue.length },
			hover: this.hover,
			grab: this.grab ? { id: this.grab.id, hand: this.grab.hand } : null,
			ready: !!this.continueOn,
			done: this.done,
			drawCalls: this.renderer?.info?.render?.calls,
			tris: this.renderer?.info?.render?.triangles,
		};
	}
}
