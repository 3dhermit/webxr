/**
 * In-headset ergonomics tuner (`?tune=1`).
 *
 * Every comfort-critical number in this lesson was chosen on a monitor: dot size, the hit
 * radius that makes a 15 mm dot tappable, text angular height, panel distance, how far the
 * video may drift before it follows. None of those can be judged outside the device, and the
 * normal loop for changing one is edit JSON, rebuild, redeploy, re-enter VR, which is far too
 * slow to compare two values against each other.
 *
 * This lets a teacher or developer adjust them live, with the controller, and read the final
 * numbers off an in-world panel as a JSON block to paste into the lesson's `runtime.ui`.
 * It is a developer surface: `?tune=1` only, never reachable in a classroom build.
 *
 * Controls (either controller, right preferred):
 *   thumbstick up/down   choose a parameter
 *   thumbstick left/right  change it (hold to accelerate)
 *   A / X                reset the chosen parameter to its authored value
 *   B / Y                cycle the panel: values -> JSON -> hidden
 */
import * as THREE from 'three';

import { XR_AXES, XR_BUTTONS } from 'gamepad-wrapper';
import { makeText } from './text.js';

export class Tuner {
	constructor({ lesson, camera, parent }) {
		this.lesson = lesson;
		this.camera = camera;
		this.sel = 0;
		this.mode = 0; // 0 values, 1 JSON, 2 hidden
		this.lastStep = 0;
		this.held = 0;

		const L = lesson;
		// Each entry owns how it is read, written and reset, so the list is the only place that
		// needs to know a parameter exists.
		this.params = [
			{
				key: 'eyeHeightMetres',
				label: 'eye height',
				unit: 'm',
				step: 0.01,
				min: 0.9,
				max: 2.1,
				get: () => L.ui.eyeY,
				// Nudge via the real calibration path so it re-plans exactly as a headset would.
				set: (v) => {
					L.ui.eyeY = v;
					L.planUi();
					L.applyUiLayout();
				},
			},
			{
				key: 'promptTextDeg',
				label: 'prompt text',
				unit: 'deg',
				step: 0.05,
				min: 0.6,
				max: 4,
				get: () => L.uiDeg.promptText,
				set: (v) => this.replan(() => (L.uiDeg.promptText = v)),
			},
			{
				key: 'feedbackTextDeg',
				label: 'feedback text',
				unit: 'deg',
				step: 0.05,
				min: 0.6,
				max: 4,
				get: () => L.uiDeg.feedText,
				set: (v) => this.replan(() => (L.uiDeg.feedText = v)),
			},
			{
				key: 'panelAngularWidthDeg',
				label: 'card width',
				unit: 'deg',
				step: 0.5,
				min: 6,
				max: 34,
				get: () => L.uiDeg.width,
				set: (v) => this.replan(() => (L.uiDeg.width = v)),
			},
			{
				key: 'panelGapDeg',
				label: 'card gap',
				unit: 'deg',
				step: 0.5,
				min: 0,
				max: 20,
				get: () => L.uiDeg.gap,
				set: (v) => this.replan(() => (L.uiDeg.gap = v)),
			},
			{
				key: 'explodeGain',
				label: 'explode spread',
				unit: 'x',
				step: 0.05,
				min: 0.1,
				max: 2.5,
				get: () => L.model.explodeGain,
				set: (v) => {
					L.model.explodeGain = v;
					L.model.apply();
					// Card placement is measured from the cloud's angular extent, so a wider
					// explosion has to re-plan the UI or the prompt ends up inside the anatomy.
					L.planUi();
					L.applyUiLayout();
				},
			},
			{
				key: 'maxExtraSpread',
				label: 'stick spread cap',
				unit: 'x',
				step: 0.1,
				min: 0,
				max: 3,
				get: () => L.maxExtraSpread,
				set: (v) => (L.maxExtraSpread = v),
			},
			{
				key: 'calloutDotScale',
				label: 'callout dot',
				unit: 'x',
				step: 0.05,
				min: 0.4,
				max: 3,
				get: () => this.dotScale ?? 1,
				set: (v) => {
					this.dotScale = v;
					// Scale the mesh rather than rebuilding geometry: the dot is a sphere, so the
					// visual size is all that matters and this is instant.
					for (const c of L.callouts) c.dot.scale.setScalar(v);
				},
			},
			{
				key: 'calloutHitMetres',
				label: 'dot hit radius',
				unit: 'm',
				step: 0.002,
				min: 0.005,
				max: 0.08,
				get: () => L.data.runtime.calloutHitMetres ?? 0.02,
				set: (v) => (L.data.runtime.calloutHitMetres = v),
			},
			{
				key: 'quizPlateMul',
				label: 'quiz plate size',
				unit: 'x',
				step: 0.1,
				min: 1.4,
				max: 5,
				get: () => L.quizPlateMul,
				set: (v) => this.replan(() => (L.quizPlateMul = v)),
			},
			{
				key: 'quizPitchMul',
				label: 'quiz spacing',
				unit: 'x',
				step: 0.02,
				min: 1,
				max: 2.2,
				get: () => L.quizPitchMul,
				set: (v) => {
					L.quizPitchMul = v;
					L.placeQuiz();
				},
			},
			{
				key: 'videoDistanceMetres',
				label: 'video distance',
				unit: 'm',
				step: 0.05,
				min: 0.5,
				max: 4,
				get: () => L.video.dist,
				set: (v) => {
					L.video.dist = v;
					L.video.layout();
					L.video.reposition(1);
				},
			},
			{
				key: 'videoFovDeg',
				label: 'video size',
				unit: 'deg',
				step: 1,
				min: 20,
				max: 100,
				get: () => L.video.fovDeg,
				set: (v) => {
					L.video.fovDeg = v;
					L.video.layout();
				},
			},
			{
				key: 'videoDeadZoneDeg',
				label: 'video dead zone',
				unit: 'deg',
				step: 0.5,
				min: 0,
				max: 25,
				get: () => L.video.deadZoneDeg,
				set: (v) => (L.video.deadZoneDeg = v),
			},
			{
				key: 'videoFollowPerSec',
				label: 'video follow',
				unit: '/s',
				step: 0.2,
				min: 0.5,
				max: 12,
				get: () => L.video.follow,
				set: (v) => (L.video.follow = v),
			},
		];
		// Clamp inside the setter rather than at the one call site that happens to drive it:
		// a parameter pushed out of range (a 0 m panel distance, a 0.1 deg font) can make the
		// lesson unreadable with no way back, and reset is the only escape in a headset.
		for (const prm of this.params) {
			const raw = prm.set;
			prm.set = (v) => raw(THREE.MathUtils.clamp(v, prm.min, prm.max));
		}

		// Authored values, captured before anything is touched, so A/X can always get back.
		this.defaults = this.params.map((p) => p.get());

		this.group = new THREE.Group();
		this.text = makeText({
			fontSize: 0.016,
			maxWidth: 0.62,
			anchorX: 'left',
			anchorY: 'top',
			color: 0xdff0ff,
		});
		this.back = new THREE.Mesh(
			new THREE.PlaneGeometry(0.68, 0.52),
			new THREE.MeshBasicMaterial({ color: 0x0a1016, transparent: true, opacity: 0.88 }),
		);
		this.back.position.set(0.32, -0.24, -0.002);
		this.group.add(this.back, this.text);
		parent.add(this.group);
		this.render();
	}

	/** Re-plan and rebuild: needed when a change alters text size or panel geometry. */
	replan(mutate) {
		mutate();
		this.lesson.planUi();
		this.lesson.rebuildUI();
		// Callout dots are rebuilt with the lesson UI, so restore any tuned dot scale.
		if (this.dotScale) for (const c of this.lesson.callouts) c.dot.scale.setScalar(this.dotScale);
	}

	/**
	 * The block to paste into the lesson's runtime.ui. Only CHANGED values are emitted: the
	 * output has to be valid JSON to be pasteable, so it cannot carry "unchanged" annotations,
	 * and a snippet of every key would silently freeze today's defaults into the lesson file.
	 */
	snippet() {
		const changed = this.params
			.map((p, i) => [p, i])
			.filter(([p, i]) => Math.abs(p.get() - this.defaults[i]) > 1e-6);
		if (!changed.length) return '{ }\n\nNothing changed yet.';
		const lines = changed.map(([p]) => `  "${p.key}": ${+p.get().toFixed(4)}`);
		return `{\n${lines.join(',\n')}\n}\n\n${changed.length} of ${this.params.length} changed.`;
	}

	render() {
		this.group.visible = this.mode !== 2;
		if (this.mode === 2) return;
		if (this.mode === 1) {
			this.text.text = `TUNED VALUES — paste into runtime.ui\n\n${this.snippet()}\n\nB/Y: hide`;
		} else {
			const rows = this.params.map((p, i) => {
				const v = p.get();
				const changed = Math.abs(v - this.defaults[i]) > 1e-6;
				const mark = i === this.sel ? '>' : ' ';
				return `${mark} ${p.label.padEnd(16)} ${(+v.toFixed(3)).toString().padStart(7)} ${p.unit}${changed ? '  *' : ''}`;
			});
			this.text.text =
				`ERGONOMICS TUNER   (* = changed)\n` +
				`stick up/down pick · left/right adjust\n` +
				`A/X reset one · B/Y show JSON\n\n${rows.join('\n')}`;
		}
		this.text.sync();
	}

	update(dt, controllers) {
		const c = controllers?.right || controllers?.left;
		const gp = c?.gamepad;
		// Park the panel in the lower-left of view, billboarded, so it never covers the thing
		// being judged.
		const cam = this.camera;
		const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
		const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
		const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
		this.group.position
			.copy(cam.position)
			.addScaledVector(fwd, 0.85)
			.addScaledVector(right, -0.52)
			.addScaledVector(up, -0.1);
		this.group.quaternion.copy(cam.quaternion);

		if (!gp) return;
		if (gp.getButtonClick?.(XR_BUTTONS.BUTTON_2)) {
			this.mode = (this.mode + 1) % 3;
			this.render();
			return;
		}
		if (this.mode === 2) return;

		const y = gp.getAxis?.(XR_AXES.THUMBSTICK_Y) ?? 0;
		const x = gp.getAxis?.(XR_AXES.THUMBSTICK_X) ?? 0;

		// Selection is discrete, so it needs a cooldown or one flick scrolls the whole list.
		this.lastStep -= dt;
		if (Math.abs(y) > 0.6 && this.lastStep <= 0) {
			this.sel = (this.sel + (y < 0 ? -1 : 1) + this.params.length) % this.params.length;
			this.lastStep = 0.22;
			this.render();
		}

		if (gp.getButtonClick?.(XR_BUTTONS.BUTTON_1)) {
			const p = this.params[this.sel];
			p.set(this.defaults[this.sel]);
			this.render();
			return;
		}

		if (Math.abs(x) > 0.15) {
			// Hold to accelerate: fine control for the first moment, then coarse, so a parameter
			// with a wide range is still reachable without 200 flicks.
			this.held = Math.min(this.held + dt, 2.5);
			const p = this.params[this.sel];
			const rate = p.step * (1 + this.held * 6);
			const next = THREE.MathUtils.clamp(p.get() + Math.sign(x) * rate * dt * 8, p.min, p.max);
			if (Math.abs(next - p.get()) > 1e-9) {
				p.set(next);
				this.render();
			}
		} else {
			this.held = 0;
		}
	}

	/** Values as a plain object, for the desktop console. */
	values() {
		return Object.fromEntries(this.params.map((p) => [p.key, +p.get().toFixed(4)]));
	}
}
