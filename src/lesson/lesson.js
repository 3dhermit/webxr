/**
 * Lesson runtime: reads the lesson JSON and runs it in world space. Every interaction maps to a
 * learning outcome, and every choice the student makes gets an immediate, specific response.
 * Nothing is stored — the classroom rule is formative feedback only, no records, no accounts.
 */
import * as THREE from 'three';
import { Panel, makeButton, makeLabel, makeLeaderLine, makeText, updateLeaderLine } from './text.js';

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
		this.ui = {
			panelW: u.panelWidthMetres ?? 0.3,
			panelZ: u.panelZMetres ?? -0.45,
			promptY: u.promptYMetres ?? 1.42,
			promptText: u.promptTextHeightMetres ?? 0.016,
			feedText: u.feedbackTextHeightMetres ?? 0.015,
			btnX: u.buttonXMetres ?? 0.24,
			btnY: u.buttonYMetres ?? 1.18,
		};

		this.t = new THREE.Vector3();
		this.ray = new THREE.Raycaster();
		this.hover = null;
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

	buildUI() {
		const { panelW, panelZ, promptY, promptText, feedText, btnX, btnY } = this.ui;
		// One panel carries the step counter inside it. A separate floating counter line printed
		// straight through the prompt panel and read as doubled text.
		this.prompt = new Panel({ width: panelW, fontSize: promptText });
		this.prompt.group.position.set(0, promptY, panelZ);
		this.feedback = new Panel({ width: panelW, fontSize: feedText });
		this.feedback.group.position.set(0, promptY - 0.12, panelZ);
		this.continueBtn = makeButton({ label: 'Continue  (trigger)', width: 0.19, height: 0.045 });
		this.continueBtn.position.set(btnX, btnY, panelZ);
		this.root.add(this.prompt.group, this.feedback.group, this.continueBtn);

		// Panels face the reader's eye height here, then track the head in update(). The Continue
		// plate sits well off-axis, so a fixed tilt made it read edge-on at the frame edge.
		this.uiParts = [this.prompt.group, this.feedback.group, this.continueBtn];
		for (const head of this.uiParts) head.lookAt(0, 1.45, 0);
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
		this.waypointGroup.visible = !!a.flow;
		if (labelIds) this.buildLabels(labelIds);
		this.hover = null;

		if (a.isolate) this.model.isolate(a.isolate);
		if (a.ghost) this.model.ghost(a.ghost);
		if (a.flow) {
			this.flow = { i: 0, misses: 0 };
			this.buildWaypoints();
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
		this.say(`Find it: ${this.partName(this.find.asked)}`, MUTED);
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
		const top = this.ui.promptY;
		this.prompt.group.position.y = top;
		this.feedback.group.position.y = top - this.prompt.height - 0.012;
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
		this.tweens = [];
		this._lit = null;
		if (this.hover) this.model.highlight(this.hover, false);
		this.hover = null;
		this.hoverSay('');
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
		if (id) {
			this.model.highlight(id, true);
			const st = this.steps[this.i];
			if (st?.action?.hoverNames) this.hoverSay(this.partName(id));
		}
	}

	hoverSay(msg) {
		if (!this.hoverLine) {
			this.hoverLine = makeText({ fontSize: 0.017, maxWidth: 0.4, anchorX: 'center', anchorY: 'bottom', color: 0xffffff });
			// Above the prompt panel, from the same layout numbers, instead of hard-coded desktop
			// coordinates — and billboarded with the rest of the UI.
			this.hoverLine.position.set(0, this.ui.promptY + 0.075, this.ui.panelZ);
			this.root.add(this.hoverLine);
			this.uiParts.push(this.hoverLine);
		}
		this.hoverLine.text = msg;
		this.hoverLine.sync();
	}

	/** A trigger press on a part. This is where formative feedback is produced. */
	select(id) {
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
				this.model.flash(id, 0x2f8f4f);
				this.flow.i += 1;
				this.flow.misses = 0;
				const hop = this.nextWaypointAfter(this.flow.i);
				this.say(hop ? `${hop.label}` : `Good — ${this.partName(id)}.`, OK);
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
			if (this.flow.misses > 2) this.say(`This one is the ${this.partName(expect)}.`, BAD);
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
			if (this.find.misses > 2) this.say(`The one you want is the ${this.partName(this.find.asked)} — it is ${this.model.parts.get(this.find.asked)?.spec.system}.`, BAD);
			else this.say(`That is the ${this.partName(id)}. Look for the ${this.partName(this.find.asked)}.`, BAD);
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
		const ct = controllers?.right || controllers?.left;
		if (!ct?.raySpace?.visible) return false;
		const o = ct.raySpace.getWorldPosition(new THREE.Vector3());
		const d = new THREE.Vector3(0, 0, -1).applyQuaternion(ct.raySpace.getWorldQuaternion(new THREE.Quaternion()));
		this.ray.set(o, d);
		return this.ray.intersectObject(this.continueBtn.userData.plate, false).length > 0;
	}

	/** Per-frame: tweens, hover picking, label billboards. */
	update(dt, controllers) {
		for (const tw of this.tweens) {
			tw.t += dt;
			const k = Math.min(1, tw.t / tw.dur);
			const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
			this.model.setFactor(tw.from + (tw.to - tw.from) * e);
		}
		this.tweens = this.tweens.filter((tw) => tw.t < tw.dur);

		const camQ = this.camera.getWorldQuaternion(new THREE.Quaternion());
		// Panels and the Continue plate face the head. The plate sits ~0.4 m off-axis, and a fixed
		// tilt made it read edge-on at the edge of the Quest field of view.
		for (const head of this.uiParts) head.quaternion.copy(camQ);

		const ct = controllers?.right || controllers?.left;
		if (ct?.raySpace?.visible) {
			const o = ct.raySpace.getWorldPosition(new THREE.Vector3());
			const d = new THREE.Vector3(0, 0, -1).applyQuaternion(ct.raySpace.getWorldQuaternion(new THREE.Quaternion()));
			this.ray.set(o, d);
			const hit = this.model.pick(this.ray, {
				hitSphereMinMetres: this.data.runtime.hitSphereMinMetres,
			});
			this.hoverPart(hit);
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
			ready: !!this.continueOn,
			done: this.done,
			drawCalls: this.renderer?.info?.render?.calls,
			tris: this.renderer?.info?.render?.triangles,
		};
	}
}
