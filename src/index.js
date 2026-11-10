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
import * as THREE from 'three';

import { XR_AXES, XR_BUTTONS } from 'gamepad-wrapper';
import { AnatomyModel } from './lesson/anatomy.js';
import { Lesson } from './lesson/lesson.js';
import { Tuner } from './lesson/tune.js';
import { init } from './init.js';
import lessonData from './lessons/heart.json';
import { makeText } from './lesson/text.js';
import registry from './assets/anatomy/parts.json';

const params = new URLSearchParams(window.location.search);
const DEBUG = params.get('debug') === '1';
// Developer surface for the in-headset ergonomics pass. Never set in a classroom build.
const TUNE = params.get('tune') === '1';

let g; // { scene, camera, renderer, player, controllers }, filled by init()
let model;
let lesson;
let status;
let hud;
let tuner;
let ready = false;
// Per-hand: did the other trigger go down during this hold? If so the release is part of a
// grab gesture, not a tap.
const triggerGesture = { right: false, left: false };
// Defect #3: the lesson UI is planned around an authored 1.45 m eye height. Measure the
// student's real one from the headset instead. Samples are collected over the first XR
// frames and reduced with a MEDIAN, because head pose on session entry is noisy (the
// student is often still lifting the headset on) and one bad frame should not set the
// layout for the whole lesson.
let eyeSamples = null;
const EYE_SAMPLES = 45;
// Reused so the sampler allocates nothing on the XR frame path.
const _eye = new THREE.Vector3();

async function boot() {
	model = await AnatomyModel.load({
		// Which model is authored in the lesson data, so switching back to the untextured
		// reference heart is a one-line JSON change rather than a rebuild of the loader.
		url: lessonData.runtime.modelUrl ?? 'assets/anatomy/heart-male.opt.glb',
		registry,
		colour: lessonData.runtime.modelColour ?? 'texture',
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
	});
	g.player.add(lesson.root);

	status.visible = false;
	lesson.enterStep(0);
	if (TUNE) {
		tuner = new Tuner({ lesson, camera: g.camera, parent: g.player });
		window.__tuner = tuner;
	}
	ready = true;

	// Dev hooks, student-mode-clean: a headset student gets no developer surface at all.
	if (DEBUG || TUNE) {
		window.__lesson = lesson;
		window.__anatomy = model;
		// Exposes the live controllers map so input gestures can be driven in a test.
		window.__globals = g;
		window.__scene = g.scene;
		window.__renderer = g.renderer;
	}
}

function setupScene({ scene, camera, renderer, player, controllers, controls }) {
	g = { scene, camera, renderer, player, controllers, controls };

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
	renderer.xr.addEventListener?.('sessionstart', () => renderer.xr.setFoveation?.(1));

	// Re-measure on every entry: 28 headsets get passed between students of different heights,
	// and a layout calibrated for the previous child is exactly the bug this fixes.
	renderer.xr.addEventListener?.('sessionstart', () => {
		eyeSamples = [];
	});
	renderer.xr.addEventListener?.('sessionend', () => {
		eyeSamples = null;
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
			else if (e.key === 'r') lesson.reset();
			else if (e.key === 'x') lesson.model.returnMoved();
			else if (e.key === '+' || e.key === '=') lesson.adjustSpread(0.15);
			else if (e.key === '-') lesson.adjustSpread(-0.15);
			else if (e.key === 'b') { lesson.hoverNav('back'); lesson.pressNav(); }
			else if (e.key === 'R') { lesson.hoverNav('reset'); lesson.pressNav(); }
			else if (e.key === 'v')
				lesson.video.isOpen ? lesson.closeVideo() : lesson.openVideo(Object.keys(lesson.data.videos || {})[0]);
			else if (e.key === '[') lesson.calibrateEye(1.28); // simulate a grade-6 student
			else if (e.key === ']') lesson.calibrateEye(1.45); // back to the authored adult height
			else if (e.key === 'c') lesson.calloutOpen != null ? lesson.closeCallout() : lesson.openCallout(lesson.callouts.findIndex((c) => c.marker.visible));
		});
	}
}

/** What a trigger TAP does, once it is known not to be half of a grab gesture. */
function triggerAction(controllers) {
	if (lesson.pressVideo()) return; // a clip is up and owns the trigger (F2)
	if (lesson.done) {
		lesson.reset();
		return;
	}
	if (lesson.pickButton(controllers)) {
		lesson.next();
		return;
	}
	if (lesson.pressNav()) return; // Back or Full Reset (F5)
	if (lesson.pressQuiz()) return; // a quiz choice plate (defect #1)
	if (lesson.pressCallout()) return; // a callout dot (F1)
	lesson.select(lesson.hover);
}

function onFrame(delta, _time, globals) {
	if (!ready) return;
	const controllers = globals.controllers;

	// Collect head height until we have enough samples, then calibrate once (see eyeSamples).
	if (eyeSamples && globals.renderer.xr.isPresenting) {
		const y = globals.camera.getWorldPosition(_eye).y;
		if (y > 0.8 && y < 2.2) eyeSamples.push(y);
		if (eyeSamples.length >= EYE_SAMPLES) {
			const sorted = eyeSamples.slice().sort((a, b) => a - b);
			lesson.calibrateEye(sorted[Math.floor(sorted.length / 2)]);
			eyeSamples = null;
		}
	}

	lesson.update(delta, controllers);
	if (tuner) tuner.update(delta, controllers);

	// Thumbstick spreads the explosion further apart or back together. The authored spread
	// leaves several parts hidden behind others, and how far is far enough depends on where
	// the student's head is, so it is theirs to set. Suppressed in ?tune=1, where the stick
	// belongs to the tuner.
	if (!tuner) {
		const sc = controllers[lesson.activeHand(controllers) ?? 'right'] || controllers.right || controllers.left;
		const sy = sc?.gamepad?.getAxis?.(XR_AXES.THUMBSTICK_Y) ?? 0;
		if (Math.abs(sy) > 0.18) lesson.adjustSpread(-sy * delta * 0.9);
	}

	// Grab is BOTH triggers held together. That gesture cannot be mistaken for a select, but
	// it does mean a select can no longer fire on trigger PRESS: the first of the two presses
	// would act before the second arrived, naming a part every time a student went to grab
	// one. So a select fires on RELEASE, and only if the other trigger stayed up for the
	// whole hold - which is what distinguishes a tap from half of a grab gesture.
	const held = {
		right: !!controllers.right?.gamepad?.getButton?.(XR_BUTTONS.TRIGGER),
		left: !!controllers.left?.gamepad?.getButton?.(XR_BUTTONS.TRIGGER),
	};
	const bothTriggers = held.right && held.left;
	if (bothTriggers && !lesson.grab) {
		// The hand that is AIMING drives the grab, not a hardcoded side - with both triggers
		// held, the hand holding the part has to be the one the pointer came from.
		lesson.grabStart(lesson.activeHand(controllers) ?? 'right', controllers, 'triggers');
	}
	// Letting go of either trigger ends a TRIGGER grab. Scoped by gesture so it cannot also
	// cancel a squeeze grab, which is held with no triggers down at all.
	if (lesson.grab?.via === 'triggers' && !bothTriggers) lesson.grabEnd(undefined, 'triggers');

	for (const hand of ['right', 'left']) {
		const gp = controllers[hand]?.gamepad;
		if (!gp) continue;
		const other = hand === 'right' ? 'left' : 'right';
		// Squeeze still grabs one-handed. It costs nothing to keep and is quicker once known.
		if (gp.getButtonDown?.(XR_BUTTONS.SQUEEZE)) {
			lesson.lastHand = hand;
			lesson.grabStart(hand, controllers, 'squeeze');
		}
		if (gp.getButtonUp?.(XR_BUTTONS.SQUEEZE)) lesson.grabEnd(hand, 'squeeze');

		if (gp.getButtonDown?.(XR_BUTTONS.TRIGGER)) triggerGesture[hand] = held[other];
		// Mark BOTH hands the moment the gesture completes, so neither release acts as a tap.
		if (bothTriggers) triggerGesture[hand] = true;
		if (gp.getButtonUp?.(XR_BUTTONS.TRIGGER)) {
			const wasGesture = triggerGesture[hand];
			triggerGesture[hand] = false;
			if (!wasGesture && !lesson.grab) {
				// A press claims control for that hand, so a left-handed student taking over
				// mid-lesson does not have to out-aim the right controller.
				lesson.lastHand = hand;
				triggerAction(controllers);
			}
		}
	}

	if (hud) {
		const s = lesson.state();
		hud.textContent = [
			`step ${s.step}  ${s.stepId}  level=${s.level}`,
			`explode ${s.factor}  hover=${s.hover ?? '-'}  ready=${s.ready}  eyeY=${s.eyeY}`,
			`flow ${s.flow.i}/8 misses=${s.flow.misses}   find left=${s.find.left}`,
			`draw ${s.drawCalls}  tris ${s.tris}`,
		].join('\n');
	}
}

if (params.get('demo') === 'tutorial') {
	import('./tutorial.js').then((t) => init(t.setupScene, t.onFrame));
} else {
	init(setupScene, onFrame);
}
