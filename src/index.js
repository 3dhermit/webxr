/**
 * Entry point. A classroom build boots straight into the lesson: no typing, no accounts, no
 * developer surface.
 *
 *   index.html                 student mode (default)
 *   index.html?level=ms        the same lesson in the younger reading register
 *   index.html?debug=1         desktop-only dev HUD plus arrow-key stepping (never in the headset)
 *   index.html?demo=tutorial   the original webxr-first-steps blaster tutorial
 *
 * Everything a student reads or presses is geometry inside the scene, because Quest Browser does
 * not support DOM overlay in immersive-vr. The ?debug=1 HUD exists only on a developer's monitor.
 */
import { AnatomyModel } from './lesson/anatomy.js';
import { Lesson } from './lesson/lesson.js';
import { XR_BUTTONS } from 'gamepad-wrapper';
import { init } from './init.js';
import lessonData from './lessons/heart.json';
import { makeText } from './lesson/text.js';
import registry from './assets/anatomy/parts.json';
import { unlockMedia } from './lesson/audio.js';

const params = new URLSearchParams(window.location.search);
const DEBUG = params.get('debug') === '1';

document.addEventListener('pointerdown', unlockMedia, true);

let g; // { scene, camera, renderer, player, controllers }, filled by init()
let model;
let lesson;
let status;
let hud;
let ready = false;

async function boot() {
	model = await AnatomyModel.load({
		url: 'assets/anatomy/heart-male.opt.glb',
		registry,
	});
	model.place(lessonData.runtime.tablePlacement);
	model.explodeGain = lessonData.runtime.explodeGain ?? 0.55;
	g.player.add(model.group);

	lesson = new Lesson({
		player: g.player,
		camera: g.camera,
		renderer: g.renderer,
		model,
		data: lessonData,
		level: params.get('level') || undefined,
		debug: DEBUG,
		sky: g.sky,
	});
	g.player.add(lesson.root);

	status.visible = false;
	lesson.enterStep(0);
	ready = true;
	if (g.renderer.xr.isPresenting) lesson.onXrStart();

	// Dev hooks, student-mode-clean: a headset student gets no developer surface at all.
	if (DEBUG) {
		window.__lesson = lesson;
		window.__anatomy = model;
		window.__scene = g.scene;
		window.__renderer = g.renderer;
	}
}

function setupScene({ scene, camera, renderer, player, controllers, controls, sky }) {
	g = { scene, camera, renderer, player, controllers, controls, sky };

	// On a monitor, put the preview camera where a student's head will be, so what the developer
	// sees is what the class sees. In the headset XR drives the camera, so OrbitControls is off.
	if (controls) {
		// Match the monitor preview to the headset: eye height, and the Quest 2 vertical field of
		// view (~88 degrees) instead of three.js's 50, so "it looks fine on my laptop" stops being
		// a lie. In immersive mode XR replaces this projection anyway.
		camera.fov = 88;
		camera.updateProjectionMatrix();
		controls.target.set(0, 1.3, -0.62);
		camera.position.set(0.02, 1.45, 0.02);
		controls.update();
		renderer.xr.addEventListener?.('sessionstart', () => {
			controls.enabled = false;
		});
		renderer.xr.addEventListener?.('sessionend', () => {
			controls.enabled = true;
		});
	}

	// Quest 2 has a narrow lens sweet spot; fixed foveation buys resolution where the eye looks.
	renderer.xr.addEventListener?.('sessionstart', () => {
		renderer.xr.setFoveation?.(1);
		lesson?.onXrStart?.();
	});

	status = makeText({
		fontSize: 0.03,
		maxWidth: 0.6,
		anchorX: 'center',
		anchorY: 'middle',
		align: 'center',
	});
	status.text = 'Preparing the heart\u2026';
	status.sync();
	status.position.set(0, 1.35, -0.6);
	player.add(status);

	boot().catch((err) => {
		console.error(err);
		status.text = 'The heart could not be loaded.\nAsk your teacher to reload the page.';
		status.sync();
	});

	if (DEBUG) {
		hud = document.createElement('div');
		hud.style.cssText =
			'position:fixed;left:12px;top:12px;z-index:9;font:12px monospace;color:#cfe;white-space:pre;background:rgba(0,0,0,.55);padding:8px 10px;border-radius:6px';
		document.body.appendChild(hud);
		window.addEventListener('keydown', (e) => {
			if (!ready) return;
			if (e.key === 'ArrowRight') lesson.next();
			else if (e.key === 'ArrowLeft') lesson.prev();
			else if (e.key === 'Enter' || e.key === ' ') lesson.select(lesson.hover);
			else if (e.key === 'v') lesson.video?.isOpen ? lesson.closeVideo() : lesson.openVideo();
			else if (e.key === 'p') lesson.togglePassthrough();
			else if (e.key === 'r') lesson.reset();
		});
	}
}

function onFrame(delta, _time, globals) {
	if (!ready) return;
	const controllers = globals.controllers;
	lesson.update(delta, controllers);

	for (const hand of ['right', 'left']) {
		const ct = controllers[hand];
		if (!ct?.gamepad?.getButtonClick?.(XR_BUTTONS.TRIGGER)) continue;
		lesson.lastHand = hand;
		const ui = lesson.pickUi(controllers, hand);
		if (ui === 'intro-audio') {
			lesson.playIntroAudio();
			continue;
		}
		if (ui === 'prompt-audio') {
			lesson.playPromptAudio();
			continue;
		}
		if (ui === 'quiz-audio') {
			lesson.playQuizAudio();
			continue;
		}
		lesson.dismissIntro();
		if (lesson.video?.isOpen) {
			lesson.aim(ct);
			lesson.videoHover = lesson.probe().ui;
			if (lesson.pressVideo()) continue;
		}
		if (lesson.done) lesson.reset();
		else if (ui === 'continue') { lesson.playClip('hud:continue'); lesson.next(); }
		else if (ui === 'play') lesson.openVideo(); // openVideo speaks the video-title clip
		else if (ui === 'pass') lesson.togglePassthrough(); // speaks the passthrough clip
		else if (ui === 'restart') lesson.askRestart(); // speaks the restart-confirm clip
		else if (ui === 'restart-yes') { lesson.playClip('hud:yes'); lesson.confirmRestart(); }
		else if (ui === 'restart-no') { lesson.playClip('hud:no'); lesson.hideRestartConfirm(); }
		else if (typeof ui === 'string' && ui.startsWith('quiz-')) lesson.answerQuiz(+ui.slice(5));
		else lesson.select(lesson.hover);
	}

	for (const hand of ['right', 'left']) {
		const gp = controllers[hand]?.gamepad;
		if (!gp) continue;
		if (gp.getButtonDown?.(XR_BUTTONS.SQUEEZE)) {
			lesson.lastHand = hand;
			lesson.grabStart(hand, controllers, 'squeeze');
		}
		if (gp.getButtonUp?.(XR_BUTTONS.SQUEEZE)) lesson.grabEnd(hand, 'squeeze');
	}

	if (controllers?.left?.gamepad?.getButton?.(XR_BUTTONS.SQUEEZE) && controllers?.right?.gamepad?.getButton?.(XR_BUTTONS.SQUEEZE)) {
		lesson._resetHold = (lesson._resetHold || 0) + delta;
		if (lesson._resetHold >= 1.5) {
			lesson._resetHold = 0;
			lesson.askRestart();
		}
	} else {
		lesson._resetHold = 0;
	}

	if (hud) {
		const s = lesson.state();
		hud.textContent = [
			`step ${s.step}  ${s.stepId}  level=${s.level}`,
			`explode ${s.factor}  hover=${s.hover ?? '-'}  ready=${s.ready}`,
			`mixer ${window.__anatomy?.stats?.()?.mixerTime?.toFixed?.(3) ?? '-'} / ${window.__anatomy?.stats?.()?.clipDuration ?? '-'}  grab=${s.grab ? s.grab.id : '-'}`,
			`flow ${s.flow ? `${s.flow.i}/8 misses=${s.flow.misses}` : '-'}   find left=${s.find.left}`,
			`draw ${s.drawCalls}  tris ${s.tris}`,
		].join('\n');
	}
}

if (params.get('demo') === 'tutorial') {
	import('./tutorial.js').then((t) => init(t.setupScene, t.onFrame));
} else {
	init(setupScene, onFrame);
}
