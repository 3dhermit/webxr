/**
 * Lesson runtime: reads the lesson JSON and runs it in world space. Every interaction maps to a
 * learning outcome, and every choice the student makes gets an immediate, specific response.
 * Nothing is stored — the classroom rule is formative feedback only, no records, no accounts.
 */
import * as THREE from 'three';
import {
	ClipBank,
	doneStems,
	feedbackStems,
	hudStems,
	introStems,
	partStems,
	promptStems,
	quizStems,
	quizWhyStems,
	videoTitleStems,
	vocabStems,
	waypointStems,
} from './audio.js';
import { Panel, btnHit, liftText, makeButton, makeLabel, makeLeaderLine, makeText, setButtonLabel, updateLeaderLine } from './text.js';
import { loadLessonScript, scriptJoin } from './script.js';
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
	constructor({ player, camera, renderer, model, data, level, debug = false, sky = null }) {
		this.player = player;
		this.camera = camera;
		this.renderer = renderer;
		this.model = model;
		this.data = data;
		this.sky = sky;
		this.passthrough = false;
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
		this.script = new Map();

		this.buildUI();
		this.scriptReady = loadLessonScript().then((m) => {
			this.script = m;
			this.applyIntroText();
			this.bindIntroClip();
			const st = this.steps[this.i];
			if (st) {
				this.applyCardText(st);
				this.bindPromptClip(st);
			}
		});
	}

	textOf(field) {
		if (!field) return '';
		return typeof field === 'string' ? field : field[this.level] || field.hs || '';
	}

	scriptText(...keys) {
		return scriptJoin(this.script, ...keys);
	}

	applyIntroText() {
		const t = this.scriptText('intro');
		if (!t || !this.introText) return;
		this.introText.text = t;
		this.introText.sync();
	}

	applyCardText(st) {
		if (!st) return;
		const card = this.scriptText(`${st.id}.${this.level}`, st.id);
		if (card) this.prompt.set(card);
		else this.prompt.set(`${st.title}\n\n${st.verb.toUpperCase()} — ${this.textOf(st.prompt)}`);
		const fb = this.scriptText(`${st.id}.feedback.${this.level}`, `${st.id}.feedback`);
		this.say(fb || this.misconceptionFor(st.id));
		if (fb) this.playClip(`feedback:${st.id}`);
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
	 * Step card: wider, viewer-right of the heart, 0.5 m in front of the organ.
	 * Starting two-verb copy is a separate centered plate that plays first.
	 */
	planUi() {
		const g = this.uiDeg;
		const rad = (d) => (d * Math.PI) / 180;
		const p = 0.5;
		this.ui.panelZ = -p;
		this.ui.panelX = 0.24;
		this.ui.panelW = 0.38;
		this.ui.promptText = p * Math.tan(rad(g.promptText));
		this.ui.feedText = p * Math.tan(rad(g.feedText));
		this.ui.panelBottom = 1.28;
		this.ui.btnX = p * Math.tan(rad(g.btnAz));
		this.ui.btnY = this.ui.eyeY + p * Math.tan(rad(g.btnElev));
		this.ui.btnW = p * Math.tan(rad(g.btnWidth));
	}

	buildUI() {
		const { panelW, panelZ, promptText, feedText, eyeY } = this.ui;
		// One panel carries the step counter inside it. A separate floating counter line printed
		// straight through the prompt panel and read as doubled text.
		this.prompt = new Panel({ width: panelW, fontSize: promptText });
		this.feedback = new Panel({ width: panelW, fontSize: feedText });
		for (const pan of [this.prompt, this.feedback]) {
			pan.back.material.depthTest = false;
			pan.back.renderOrder = 16;
			pan.text.material.depthTest = false;
			pan.text.material.depthWrite = false;
			pan.text.renderOrder = 17;
			pan.text.position.z = 0.012;
		}
		// troika measures wrapped text asynchronously, so the measured height arrives after set().
		// Re-anchor the stack each time a panel is remeasured, or the backdrop keeps the previous
		// prompt's height and the extra lines spill off it onto the model.
		this.prompt.onfit = () => this.relayout();
		this.feedback.onfit = () => this.relayout();
		this.prompt.group.position.set(this.ui.panelX, this.ui.panelBottom, panelZ);
		this.feedback.group.position.set(this.ui.panelX, this.ui.panelBottom, panelZ);
		this.clips = new ClipBank();
		this.clipCache = new Map();
		for (const [key, stems] of Object.entries(this.oneShotStems())) {
			// Pre-locate every one-shot clip while the student is still on the intro, so the
			// first trigger (step 2 feedback, first waypoint, first "Find it") plays instantly.
			this.clips.locate(stems).then((c) => this.clipCache.set(key, c));
		}
		this.promptSpeaker = this.buildSpeakerIcon();
		this.promptSpeaker.position.set(-this.ui.panelW * 0.5 - 0.04, -0.02, 0.02);
		this.promptSpeaker.visible = false;
		this.prompt.group.add(this.promptSpeaker);
		this.promptClip = [];
		// The plate is sized from the same angular spec as everything else, so it stays the same
		// apparent size on the lens when the card moves closer to or further from the face.
		// Tiny stand-ins — later swapped for designed image plates.
		const hudW = 0.088;
		const hudH = 0.026;
		const hudFs = 0.012;
		this.continueBtn = makeButton({
			label: 'Continue',
			width: hudW * 1.18,
			height: hudH * 1.18,
			fontSize: hudFs * 1.18,
		});
		this.continueBtn.userData.plate.material = new THREE.MeshBasicMaterial({
			color: 0x22c55e,
			transparent: true,
			opacity: 1,
			depthTest: false,
			depthWrite: false,
		});
		this.continueBtn.userData.plate.renderOrder = 28;
		this.continueBtn.userData.caption.position.z = 0.012;
		liftText(this.continueBtn.userData.caption, 32);
		this.playBtn = makeButton({ label: 'Play video', width: hudW, height: hudH, fontSize: hudFs });
		this.passBtn = makeButton({ label: 'Passthrough', width: hudW, height: hudH, fontSize: hudFs });
		this.hudBtns = new THREE.Group();
		this.hudBtns.position.set(0, 0, -0.5);
		const hudY = -0.20;
		const hudX = 0.19;
		this.playBtn.position.set(-hudX, hudY, 0);
		this.passBtn.position.set(0, hudY, 0);
		this.restartBtn = makeButton({ label: 'Restart', width: hudW, height: hudH, fontSize: hudFs });
		this.restartBtn.position.set(hudX, hudY, 0);
		this.yesBtn = makeButton({ label: 'Yes', width: hudW, height: hudH, fontSize: hudFs });
		this.noBtn = makeButton({ label: 'No', width: hudW, height: hudH, fontSize: hudFs });
		this.yesBtn.position.set(-0.1, hudY - 0.10, 0);
		this.noBtn.position.set(0.1, hudY - 0.10, 0);
		this.yesBtn.visible = false;
		this.noBtn.visible = false;
		this.restartAsk = makeText({
			fontSize: hudFs,
			maxWidth: 0.28,
			anchorX: 'center',
			anchorY: 'middle',
			align: 'center',
			color: 0xffffff,
		});
		this.restartAsk.text = 'Restart?';
		this.restartAsk.sync();
		this.restartAsk.position.set(0, hudY - 0.068, 0.008);
		this.restartAsk.visible = false;
		this.restartAsk.material.depthTest = false;
		this.restartAsk.renderOrder = 41;
		this.hudBtns.add(this.playBtn, this.passBtn, this.restartBtn, this.yesBtn, this.noBtn, this.restartAsk);
		this.player.add(this.continueBtn);
		this.buildStepDots();
		this.buildIntro();
		this.camera.add(this.hudBtns);
		this.root.add(this.prompt.group, this.feedback.group);

		this.quiz = null;
		this._quizDone = false;
		this.buildQuizHud();

		this.uiParts = [this.prompt.group, this.feedback.group];
		// Face the seated player origin once. Do NOT copy head yaw each frame — that made
		// the cards swing left/right with every look.
		for (const head of this.uiParts) head.lookAt(0, eyeY, 0);

		// World-locked lecture clip. Not tied to a step: the Play video plate is always available.
		this.video = new VideoScreen({
			camera: this.camera,
			parent: this.camera,
			videos: this.data.videos || {},
			runtime: this.data.runtime || {},
		});
		// HUD-docked: same plane as the chips, to their right. Smaller than the old
		// world-locked lecture screen so it sits next to Play / Passthrough / Restart.
		this.video.dist = 0.5;
		this.video.fovDeg = 16;
		this.video.followHead = false;
		this.video.dock = { x: 0.40, y: -0.20, z: -0.5 };
		this.videoHover = null;
	}

	/**
	 * Quiz card lives in player space, parked to the left of the exploded right atrium.
	 * Not camera-parented — that glued it to the gaze and covered the HUD. Type is sized for
	 * Quest 2 (~18.5 px/deg): heading 42 px, body 30 px, answers 28 px.
	 */
	buildQuizHud() {
		const dist = 0.8;
		const px = (pxSize) => dist * Math.tan(((pxSize / 18.5) * Math.PI) / 180);
		this.quizDist = dist;
		this.quizCardW = 0.4;
		this.quizHud = new THREE.Group();
		this.quizHud.visible = false;
		this.player.add(this.quizHud);

		const cardW = this.quizCardW;
		this.quizBack = new THREE.Mesh(
			new THREE.PlaneGeometry(cardW, 0.16),
			new THREE.MeshBasicMaterial({
				color: 0x101418,
				transparent: true,
				opacity: 0.92,
				depthTest: false,
				depthWrite: false,
			}),
		);
		this.quizBack.position.set(0, 0.08, -0.02);
		this.quizBack.renderOrder = 8;
		this.quizBack.raycast = () => {};

		this.quizTitle = makeText({
			fontSize: px(42),
			maxWidth: cardW - 0.04,
			anchorX: 'center',
			anchorY: 'bottom',
			align: 'center',
			color: 0xffffff,
			lineHeight: 1.3,
		});
		this.quizBody = makeText({
			fontSize: px(30),
			maxWidth: cardW - 0.04,
			anchorX: 'center',
			anchorY: 'top',
			align: 'center',
			color: 0xf2f2f2,
			lineHeight: 1.35,
		});
		this.quizTitle.position.set(0, 0.14, 0.02);
		this.quizBody.position.set(0, 0.12, 0.02);
		this.liftQuizText();
		this.quizHud.add(this.quizBack, this.quizTitle, this.quizBody);
		this.quizSpeaker = this.buildSpeakerIcon();
		this.quizSpeaker.position.set(-this.quizCardW * 0.5 - 0.04, 0.08, 0.03);
		this.quizSpeaker.visible = false;
		this.quizHud.add(this.quizSpeaker);
		this.quizClip = [];

		this.quizBtns = [];
		// One full-width row per answer so long choices (quiz 2) wrap on the plate
		// instead of overflowing into the neighbour and vanishing behind it.
		this.quizBtnW = cardW - 0.04;
		this.quizBtnH = 0.062;
		this.quizBtnGap = 0.016;
		const bw = this.quizBtnW;
		const bh = this.quizBtnH;
		for (let i = 0; i < 4; i++) {
			const b = makeButton({ label: ' ', width: bw, height: bh, fontSize: px(24), hitScale: 1.1 });
			b.userData.plate.material = new THREE.MeshBasicMaterial({
				color: 0x2f6fb3,
				transparent: true,
				opacity: 0.92,
				depthTest: false,
				depthWrite: false,
			});
			b.userData.plate.renderOrder = 40;
			b.userData.caption.maxWidth = bw - 0.03;
			b.userData.caption.position.z = 0.05;
			liftText(b.userData.caption, 50);
			b.visible = false;
			this.quizHud.add(b);
			this.quizBtns.push(b);
		}
	}

	/** Five dots above the HUD chips. Progress is the dots, not "Step 3 of 5" copy. */
	buildStepDots() {
		this.stepDots = new THREE.Group();
		this.stepDots.position.set(0, -0.13, 0);
		this.hudBtns.add(this.stepDots);
		const n = this.steps.length;
		const gap = 0.014;
		const geo = new THREE.CircleGeometry(0.0038, 16);
		for (let i = 0; i < n; i++) {
			const d = new THREE.Mesh(
				geo,
				new THREE.MeshBasicMaterial({ color: 0x3a4550, depthTest: false, depthWrite: false }),
			);
			d.position.x = (i - (n - 1) / 2) * gap;
			d.renderOrder = 41;
			d.raycast = () => {};
			this.stepDots.add(d);
		}
	}

	updateStepDots() {
		if (!this.stepDots) return;
		this.stepDots.children.forEach((d, i) => {
			d.material.color.setHex(i < this.i ? 0x8fe3a0 : i === this.i ? 0xffffff : 0x3a4550);
			d.scale.setScalar(i === this.i ? 1.3 : 1);
		});
	}

	/** White speaker cone + hit plate. Trigger plays the clip (user-gesture unlock). */
	buildSpeakerIcon() {
		const g = new THREE.Group();
		const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false });
		const body = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.02, 0.01), mat);
		const horn = new THREE.Mesh(new THREE.ConeGeometry(0.014, 0.018, 8), mat);
		horn.rotation.z = -Math.PI / 2;
		horn.position.x = 0.014;
		const w1 = new THREE.Mesh(new THREE.TorusGeometry(0.016, 0.002, 6, 10, Math.PI), mat);
		w1.rotation.set(0, 0, -Math.PI / 2);
		w1.position.x = 0.028;
		const w2 = new THREE.Mesh(new THREE.TorusGeometry(0.024, 0.002, 6, 10, Math.PI), mat);
		w2.rotation.set(0, 0, -Math.PI / 2);
		w2.position.x = 0.032;
		const hit = new THREE.Mesh(
			new THREE.PlaneGeometry(0.07, 0.07),
			new THREE.MeshBasicMaterial({ visible: false, depthTest: false, depthWrite: false }),
		);
		hit.renderOrder = 43;
		body.renderOrder = 42;
		horn.renderOrder = 42;
		w1.renderOrder = 42;
		w2.renderOrder = 42;
		g.add(body, horn, w1, w2, hit);
		g.userData.hit = hit;
		return g;
	}

	playIntroAudio() {
		this.introTimer = Math.max(this.introTimer, 14);
		return this.clips.play(this.introClip);
	}

	/** English-man intro clip. No-op until the file is located and the intro is on screen. */
	tryPlayIntroAudio() {
		if (!this.introClip?.length) return false;
		if (!(this._awaitIntro || this.intro?.visible)) return false;
		return this.playIntroAudio();
	}

	/** ENTER VR is the start of the experience — speak the start instructions then. */
	onXrStart() {
		if (!(this._awaitIntro || this.intro?.visible)) this.startIntro();
		this.tryPlayIntroAudio();
	}

	playPromptAudio() {
		return this.clips.play(this.promptClip);
	}

	playQuizAudio() {
		return this.clips.play(this.quizClip);
	}

	stopLessonAudio() {
		this.clips?.stop();
	}

	/**
	 * Every one-shot clip this lesson can trigger, keyed by a stable string. Pre-located in the
	 * constructor; playClip(key) fires the found clip. A key with no matching file resolves to
	 * [] and playClip is a silent no-op — the app must never break because a clip is missing.
	 */
	oneShotStems() {
		const s = {};
		for (const m of this.data.misconceptions || []) s[`feedback:${m.step}`] = feedbackStems(m.step, this.level);
		for (const id of this.data.tiers?.core || []) s[`part:${id}`] = partStems(id);
		for (const hop of this.data.flow?.order || []) {
			if (hop.kind === 'waypoint') s[`waypoint:${hop.id}`] = waypointStems(hop.id);
		}
		for (const v of this.data.vocab || []) s[`vocab:${v.term}`] = vocabStems(v.term, this.level);
		(this.data.quiz || []).forEach((_, n) => (s[`quiz-why:${n}`] = quizWhyStems(n)));
		for (const name of ['play', 'passthrough', 'continue', 'restart', 'restart-confirm', 'yes', 'no']) {
			s[`hud:${name}`] = hudStems(name);
		}
		s['done'] = doneStems();
		s['video-title'] = videoTitleStems();
		return s;
	}

	/** Play a pre-located one-shot clip. False (silent) if the clip does not exist. */
	playClip(key) {
		const c = this.clipCache.get(key);
		return c && c.length ? this.clips.play(c) : false;
	}

	async bindIntroClip() {
		this.introClip = await this.clips.locate(introStems());
		if (this.introSpeaker) this.introSpeaker.visible = this.introClip.length > 0;
		this.tryPlayIntroAudio();
	}

	async bindPromptClip(st) {
		this.promptClip = st ? await this.clips.locate(promptStems(st.id, this.level)) : [];
		if (this.promptSpeaker) this.promptSpeaker.visible = this.promptClip.length > 0;
	}

	async bindQuizClip(n) {
		this.quizClip = await this.clips.locate(quizStems(n));
		if (this.quizSpeaker) this.quizSpeaker.visible = this.quizClip.length > 0;
		// Play once the file is bound. Locate is async; skip if this quiz was already closed.
		if (this.quiz && this.quiz.n === n) this.playQuizAudio();
	}

	buildIntro() {
		this.intro = new THREE.Group();
		this.intro.position.set(0, 1.4, -0.48);
		this.intro.visible = false;
		this.player.add(this.intro);
		this.introText = makeText({
			fontSize: 0.028,
			maxWidth: 0.55,
			anchorX: 'center',
			anchorY: 'middle',
			align: 'center',
			color: 0xffffff,
			lineHeight: 1.35,
		});
		this.introText.text = 'Trigger is select or next.\nSqueeze to pick up a part.\nHold both grips to start over.';
		this.introText.sync();
		this.introText.material.depthTest = false;
		this.introText.material.depthWrite = false;
		this.introText.renderOrder = 42;
		this.intro.add(this.introText);
		this.introSpeaker = this.buildSpeakerIcon();
		this.introSpeaker.position.set(-0.3, 0, 0.02);
		this.introSpeaker.visible = false;
		this.intro.add(this.introSpeaker);
		this.introClip = [];
		this.bindIntroClip();
		this.intro.lookAt(0, 1.45, 0);
		this.introTimer = 0;
		this.startIntro();
	}

	startIntro() {
		this._awaitIntro = true;
		this.setCardFade(0);
		this.fadeContinue(false);
		if (this.prompt) this.prompt.group.visible = false;
		if (this.feedback) this.feedback.group.visible = false;
		this.introTimer = 10;
		if (this.intro) this.intro.visible = true;
		if (this.introText) this.introText.fillOpacity = 0;
		this._introFade = { from: 0, to: 1, t: 0, dur: 0.55 };
		this.tryPlayIntroAudio();
	}

	dismissIntro() {
		if (!this.intro?.visible && !this._awaitIntro) return;
		this.introTimer = 0;
		this.stopLessonAudio();
	}

	tickIntro(dt) {
		if (this._awaitIntro || this.intro?.visible) this.introTimer -= dt;
		if (this.introTimer <= 0 && this._introFade?.to !== 0 && (this.intro?.visible || this._awaitIntro)) {
			this._introFade = { from: this.introText?.fillOpacity ?? 1, to: 0, t: 0, dur: 0.45 };
		}
		if (this._introFade) {
			this._introFade.t += dt;
			const k = Math.min(1, this._introFade.t / this._introFade.dur);
			const v = this._introFade.from + (this._introFade.to - this._introFade.from) * k;
			if (this.introText) this.introText.fillOpacity = v;
			if (this.intro) this.intro.visible = v > 0.02 || this._introFade.to === 1;
			if (k >= 1) {
				const out = this._introFade.to === 0;
				this._introFade = null;
				if (out) {
					if (this.intro) this.intro.visible = false;
					this._awaitIntro = false;
					this.beginCardFade();
				}
			}
			return;
		}
	}

	setCardFade(k) {
		const t = Math.max(0, Math.min(1, k));
		for (const pan of [this.prompt, this.feedback]) {
			if (!pan) continue;
			pan.back.material.opacity = 0.82 * t;
			pan.text.fillOpacity = t;
			pan.group.visible = t > 0.02;
		}
	}

	beginCardFade() {
		if (this.prompt) this.prompt.group.visible = true;
		if (this.feedback) this.feedback.group.visible = true;
		this._cardFade = { from: 0, to: 1, t: 0, dur: 0.7 };
		this.setCardFade(0);
		if (this.continueOn) this.fadeContinue(true);
	}

	tickCardFade(dt) {
		if (!this._cardFade) return;
		this._cardFade.t += dt;
		const k = Math.min(1, this._cardFade.t / this._cardFade.dur);
		const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
		this.setCardFade(this._cardFade.from + (this._cardFade.to - this._cardFade.from) * e);
		if (k >= 1) this._cardFade = null;
	}

	/**
	 * Keep instruction plates off the heart mesh. Push along the XZ vector from the heart
	 * centre until the card's box clears the heart box plus 4 cm.
	 */
	clearCardsFromHeart() {
		if (!this.model?.group) return;
		const heart = new THREE.Box3().setFromObject(this.model.group);
		heart.expandByScalar(0.04);
		const hc = heart.getCenter(new THREE.Vector3());
		const tmp = new THREE.Vector3();
		const dir = new THREE.Vector3();
		const cards = [this.prompt?.group, this.feedback?.group];
		if (this.intro?.visible) cards.push(this.intro);
		if (this.quizHud?.visible) cards.push(this.quizHud);
		for (const g of cards) {
			if (!g?.visible) continue;
			for (let n = 0; n < 16; n++) {
				const box = new THREE.Box3().setFromObject(g);
				if (!box.intersectsBox(heart)) break;
				box.getCenter(tmp);
				dir.copy(tmp).sub(hc);
				dir.y = 0;
				if (dir.lengthSq() < 1e-8) dir.set(1, 0, 0);
				dir.normalize();
				g.getWorldPosition(tmp).addScaledVector(dir, 0.025);
				if (g.parent) g.parent.worldToLocal(tmp);
				g.position.copy(tmp);
			}
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
			const reach = 0.12 + i * 0.02;
			g.userData.lab.position.set(out.x * reach, 0.05 + (i % 2) * 0.07, out.z * reach);
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
		if (a.flow) this.model.forceOpaque();
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

		this.applyCardText(st);
		this.setContinueEnabled(!a.flow && !a.reassemble);
		this.updateStepDots();
		this.relayout();
		this.bindPromptClip(st);
		if (st.action?.flow) {
			// Announce the first hop as soon as the trace step opens; later hops announce on select.
			const hop = this.nextWaypointAfter(0);
			if (hop) this.playClip(`waypoint:${hop.id}`);
		}
		if (this._awaitIntro) this.setCardFade(0);
		else this.beginCardFade();
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
		// Step 4 (trace) must stay fully opaque — do not ghost occluders. They still leave
		// the pick set so the student can point through to the asked part.
		if (blockers.length && !this.steps[this.i]?.action?.flow) this.model.ghost(blockers, 0.3);
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
		this.playClip(`part:${this.find.asked}`);
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
		for (const pan of [this.prompt, this.feedback]) {
			pan.text.material.depthTest = false;
			pan.text.material.depthWrite = false;
			pan.text.renderOrder = 17;
			pan.back.material.depthTest = false;
			pan.back.renderOrder = 16;
		}
	}

	setContinueEnabled(on) {
		this.continueOn = on;
		const plate = this.continueBtn.userData.plate;
		plate.material.color.setHex(on ? 0x22c55e : 0x3a4550);
		this.continueBtn.userData.caption.color = on ? 0xffffff : 0x8a97a3;
		this.continueBtn.userData.caption.sync(() => {
			liftText(this.continueBtn.userData.caption, 32);
			this.applyContinueCaption(this._contOp ?? (on ? 1 : 0));
		});
		if (!this.quiz && !this._awaitIntro) this.fadeContinue(on);
		else if (!on) this.fadeContinue(false);
	}

	fadeContinue(show) {
		const from = this._contOp ?? (show ? 0 : 1);
		this._continuePick = !!show;
		this._contFade = { from, to: show ? 1 : 0, t: 0, dur: show ? 0.25 : 0.2 };
		this.continueBtn.visible = true;
	}

	setContinueFade(k) {
		const t = Math.max(0, Math.min(1, k));
		this._contOp = t;
		const plate = this.continueBtn?.userData?.plate;
		if (plate?.material) {
			plate.material.transparent = true;
			plate.material.opacity = t;
		}
		this.applyContinueCaption(t);
		this._contY = 0.008 * (1 - t);
	}

	applyContinueCaption(t) {
		const cap = this.continueBtn?.userData?.caption;
		if (!cap) return;
		liftText(cap, 32);
		cap.fillOpacity = t;
		cap.outlineOpacity = 0.75 * t;
		cap.strokeOpacity = t;
		cap.traverse((o) => {
			const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
			for (const m of mats) {
				m.transparent = true;
				m.opacity = t;
				m.depthTest = false;
				m.depthWrite = false;
			}
		});
	}

	tickContinueFade(dt) {
		if (!this._contFade) return;
		this._contFade.t += dt;
		const dur = this._contFade.dur;
		const k = Math.min(1, this._contFade.t / dur);
		const e = this._contFade.to === 1 ? 1 - (1 - k) * (1 - k) : k;
		this.setContinueFade(this._contFade.from + (this._contFade.to - this._contFade.from) * e);
		if (k >= 1) this._contFade = null;
	}

	placeContinueOnHeart() {
		if (!this.continueBtn || !this.model?.group) return;
		const box = new THREE.Box3().setFromObject(this.model.group);
		const c = box.getCenter(new THREE.Vector3());
		const eye = this.camera.getWorldPosition(new THREE.Vector3());
		const toward = eye.clone().sub(c);
		toward.y = 0;
		if (toward.lengthSq() < 1e-8) toward.set(0, 0, 1);
		toward.normalize();
		// Park under the organ, then step toward the student so the mesh does not swallow the chip.
		c.y = box.min.y - 0.06 - (this._contY || 0);
		c.addScaledVector(toward, 0.05);
		this.player.worldToLocal(c);
		this.continueBtn.position.copy(c);
		this.continueBtn.lookAt(0, this.ui.eyeY, 0);
	}

	/** Right of the heart, stacked above its centre; follows explode like the quiz card. */
	placeInstructionCards() {
		if (this._awaitIntro || this.quiz) return;
		if (!this.model?.group) return;
		if (!this.prompt?.group.visible && !this.feedback?.group.visible) return;
		const box = new THREE.Box3().setFromObject(this.model.group);
		const c = box.getCenter(new THREE.Vector3());
		const size = box.getSize(new THREE.Vector3());
		const cardW = this.ui.panelW || 0.38;
		const gap = 0.05;
		const ph = this.prompt.height || 0.04;
		const fh = this.feedback.height || 0;
		const stack = ph + (fh ? 0.012 + fh : 0);
		const pos = c.clone();
		pos.x += size.x * 0.5 + gap + cardW * 0.5;
		pos.y += size.y * 0.35;
		this.player.worldToLocal(pos);
		const bottom = pos.y - stack * 0.5;
		this.feedback.group.position.set(pos.x, bottom + fh, pos.z);
		this.prompt.group.position.set(pos.x, bottom + fh + (fh ? 0.012 : 0) + ph, pos.z);
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
		this.fadeContinue(false);
		this.playBtn.visible = false;
		if (this.passBtn) this.passBtn.visible = false;
		this.prompt.group.visible = false;
		this.feedback.group.visible = false;
		this.labelGroup.visible = false;
		this.lineGroup.visible = false;
		this.waypointGroup.visible = false;
		this.showHoverName(null);
		this.clearSelected();
		this.dismissIntro();
		const title = item.title || `Quiz ${n + 1}`;
		this.quizTitle.text = title;
		this.quizTitle.sync(() => this.liftQuizText());
		this.quizBody.text = item.q;
		this.quizBody.sync(() => this.liftQuizText());
		this.liftQuizText();
		this.placeQuizBtns();
		item.choices.forEach((c, i) => {
			const b = this.quizBtns[i];
			if (!b) return;
			b.userData.caption.text = c;
			b.userData.caption.sync(() => this.liftQuizText());
			b.visible = true;
		});
		this.liftQuizText();
		this.quizHud.visible = true;
		this.stopLessonAudio();
		this.bindQuizClip(n);
		this.placeQuizNearRA();
		return true;
	}

	/** Choice plates in camera-local space, under the question, never in world space. */
	placeQuizBtns() {
		const bh = this.quizBtnH || 0.062;
		const gap = this.quizBtnGap || 0.016;
		this.quizBtns.forEach((b, i) => {
			b.position.set(0, -0.02 - i * (bh + gap), 0.04);
		});
	}

	hideQuiz() {
		this.quiz = null;
		this.quizHud.visible = false;
		if (this.quizSpeaker) this.quizSpeaker.visible = false;
		this.stopLessonAudio();
		for (const b of this.quizBtns || []) b.visible = false;
		this.fadeContinue(this.continueOn);
		this.playBtn.visible = true;
		if (this.passBtn) this.passBtn.visible = true;
		this.prompt.group.visible = true;
		this.feedback.group.visible = true;
		const a = this.steps[this.i]?.action || {};
		this.labelGroup.visible = a.labels === 'core' || Array.isArray(a.labels);
		this.lineGroup.visible = this.labelGroup.visible;
		this.waypointGroup.visible = !!a.flow;
		this.model.forceOpaque();
	}

	/** Troika rebuilds materials on sync — keep type above the dark plate. */
	liftQuizText() {
		for (const t of [this.quizTitle, this.quizBody]) liftText(t, 45);
		for (const b of this.quizBtns || []) {
			liftText(b.userData?.caption, 50);
			if (b.userData.plate) b.userData.plate.renderOrder = 40;
		}
	}

	/** Park the quiz to the left of the right atrium (viewer-left of RA). */
	placeQuizNearRA() {
		if (!this.quizHud?.visible) return;
		const ra = this.model.center('UBERON:0002078');
		const rad = this.model.radius('UBERON:0002078') || 0.05;
		const camQ = this.camera.getWorldQuaternion(new THREE.Quaternion());
		const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camQ);
		const cardW = this.quizCardW || 0.4;
		const gap = 0.03;
		const pos = ra.clone().addScaledVector(right, -(rad + gap + cardW / 2));
		this.player.worldToLocal(pos);
		this.quizHud.position.copy(pos);
		const parentQ = this.player.getWorldQuaternion(new THREE.Quaternion());
		this.quizHud.quaternion.copy(parentQ.invert()).multiply(camQ);
	}

	answerQuiz(i) {
		if (!this.quiz) return false;
		const { item, n } = this.quiz;
		if (i === item.answer) {
			this.say(`Quiz ${n + 1} — correct. ${item.why}`, OK);
			this.playClip(`quiz-why:${n}`);
			this._quizDone = true;
			this.hideQuiz();
			this.beginLeave(() => {
				if (this.i >= this.steps.length - 1) this.finish();
				else this.enterStep(this.i + 1);
			});
			return true;
		}
		this.say(`Quiz ${n + 1} — not that one. ${item.why}`, BAD);
		this.playClip(`quiz-why:${n}`);
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
		this.playClip('done');
		this.setContinueEnabled(true);
		this.fire('finish');
	}

	/** Reset for the next student: full state wipe, no records kept anywhere. */
	reset() {
		this.hideRestartConfirm();
		this.stopLessonAudio();
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
		this.startIntro();
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
		const label = at.clone().addScaledVector(toEye, Math.min(r + 0.11, d * 0.5));
		label.y += r * 0.95 + 0.08;
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
				if (hop) this.playClip(`waypoint:${hop.id}`);
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
		const v = (this.data.vocab || []).find((x) => (x.ids || []).includes(id));
		if (v) this.playClip(`vocab:${v.term}`);
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
			this.labelGroup,
			this.lineGroup,
			this.waypointGroup,
			this.hovGroup,
			this.hovLine,
			this.selGroup,
			this.selLine,
			this.quizHud,
			this.intro,
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
		this.playClip('video-title');
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

	askRestart() {
		this._restartAsk = true;
		if (this.restartBtn) this.restartBtn.visible = false;
		if (this.yesBtn) this.yesBtn.visible = true;
		if (this.noBtn) this.noBtn.visible = true;
		if (this.restartAsk) this.restartAsk.visible = true;
		this.playClip('hud:restart-confirm');
		return true;
	}

	hideRestartConfirm() {
		this._restartAsk = false;
		if (this.restartBtn) this.restartBtn.visible = true;
		if (this.yesBtn) this.yesBtn.visible = false;
		if (this.noBtn) this.noBtn.visible = false;
		if (this.restartAsk) this.restartAsk.visible = false;
		return true;
	}

	confirmRestart() {
		this.hideRestartConfirm();
		this.reset();
		return true;
	}

	togglePassthrough() {
		this.playClip('hud:passthrough');
		this.passthrough = !this.passthrough;
		if (this.sky) this.sky.visible = !this.passthrough;
		setButtonLabel(this.passBtn, this.passthrough ? '360 sky' : 'Passthrough');
		return true;
	}

	aim(ct) {
		if (!ct?.raySpace?.visible) return false;
		const o = ct.raySpace.getWorldPosition(new THREE.Vector3());
		const d = new THREE.Vector3(0, 0, -1).applyQuaternion(ct.raySpace.getWorldQuaternion(new THREE.Quaternion()));
		this.ray.set(o, d);
		return true;
	}

	uiFromRay() {
		if (this.intro?.visible && this.introSpeaker && this.ray.intersectObject(this.introSpeaker.userData.hit, false).length)
			return 'intro-audio';
		if (this.promptSpeaker?.visible && this.prompt?.group.visible && this.ray.intersectObject(this.promptSpeaker.userData.hit, false).length)
			return 'prompt-audio';
		if (this.quizSpeaker?.visible && this.quizHud?.visible && this.ray.intersectObject(this.quizSpeaker.userData.hit, false).length)
			return 'quiz-audio';
		if (this.continueOn && this._continuePick !== false && this.continueBtn.visible && this.ray.intersectObject(btnHit(this.continueBtn), false).length)
			return 'continue';
		if (this.playBtn.visible && this.ray.intersectObject(btnHit(this.playBtn), false).length) return 'play';
		if (this.passBtn?.visible && this.ray.intersectObject(btnHit(this.passBtn), false).length) return 'pass';
		if (this.yesBtn?.visible && this.ray.intersectObject(btnHit(this.yesBtn), false).length) return 'restart-yes';
		if (this.noBtn?.visible && this.ray.intersectObject(btnHit(this.noBtn), false).length) return 'restart-no';
		if (this.restartBtn?.visible && this.ray.intersectObject(btnHit(this.restartBtn), false).length) return 'restart';
		if (this.quiz) {
			for (let i = 0; i < this.quizBtns.length; i++) {
				const b = this.quizBtns[i];
				if (b.visible && this.ray.intersectObject(btnHit(b), false).length) return `quiz-${i}`;
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
		if (ui === 'intro-audio') {
			const hit = this.ray.intersectObject(this.introSpeaker.userData.hit, false)[0];
			return { dist: hit?.distance ?? null, ui, partId: null };
		}
		if (ui === 'prompt-audio') {
			const hit = this.ray.intersectObject(this.promptSpeaker.userData.hit, false)[0];
			return { dist: hit?.distance ?? null, ui, partId: null };
		}
		if (ui === 'quiz-audio') {
			const hit = this.ray.intersectObject(this.quizSpeaker.userData.hit, false)[0];
			return { dist: hit?.distance ?? null, ui, partId: null };
		}
		if (ui === 'continue') {
			const hit = this.ray.intersectObject(btnHit(this.continueBtn), false)[0];
			return { dist: hit?.distance ?? null, ui, partId: null };
		}
		if (ui === 'play') {
			const hit = this.ray.intersectObject(btnHit(this.playBtn), false)[0];
			return { dist: hit?.distance ?? null, ui, partId: null };
		}
		if (ui === 'pass') {
			const hit = this.ray.intersectObject(btnHit(this.passBtn), false)[0];
			return { dist: hit?.distance ?? null, ui, partId: null };
		}
		if (ui === 'restart') {
			const hit = this.ray.intersectObject(btnHit(this.restartBtn), false)[0];
			return { dist: hit?.distance ?? null, ui, partId: null };
		}
		if (ui === 'restart-yes') {
			const hit = this.ray.intersectObject(btnHit(this.yesBtn), false)[0];
			return { dist: hit?.distance ?? null, ui, partId: null };
		}
		if (ui === 'restart-no') {
			const hit = this.ray.intersectObject(btnHit(this.noBtn), false)[0];
			return { dist: hit?.distance ?? null, ui, partId: null };
		}
		if (ui && ui.startsWith('quiz-')) {
			const b = this.quizBtns[+ui.slice(5)];
			const hit = b ? this.ray.intersectObject(btnHit(b), false)[0] : null;
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
		this.tickIntro(dt);
		this.tickCardFade(dt);
		this.tickContinueFade(dt);
		this.placeContinueOnHeart();
		this.placeInstructionCards();
		if (this.quiz) this.placeQuizNearRA();
		this.clearCardsFromHeart();

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

		const camQ = this.camera.getWorldQuaternion(new THREE.Quaternion());
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
			const r = Math.max(0.48, d.length() + 0.28);
			items.push({ lab, c, anchorR: this.model.radius(id), r, az: Math.atan2(d.x, -d.z), el: Math.atan2(d.y, Math.hypot(d.x, d.z)) });
		}
		items.sort((a, b) => a.az - b.az).forEach((it, i) => (it.r += i % 2 ? 0.16 : 0));
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
