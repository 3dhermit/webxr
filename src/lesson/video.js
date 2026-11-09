/**
 * F2: flat video pop-up.
 *
 * A lecture clip plays on a single quad parked in front of the student's face. It is NOT a
 * 360 projection: the source is ordinary 16:9 footage, so wrapping it on a sphere would
 * stretch it and put most of the frame behind the viewer's head.
 *
 * The screen follows the head with a lag and a dead zone rather than being welded to it.
 * A quad locked rigidly to the view moves with every micro-saccade of head motion, which
 * reads as the world swimming and is a known comfort problem; a quad that never follows
 * forces the student to hold their neck still for the whole clip. Easing toward the gaze
 * direction, and only once it has drifted past a few degrees, gives a panel that stays
 * readable while still letting the viewer glance around its edges.
 *
 * Nothing is preloaded. The elements are created on first open and kept afterwards so a
 * clip resumes where the student left it, which also keeps the 17 MB asset off the boot path.
 */
import * as THREE from 'three';

import { makeButton, makeText } from './text.js';

export class VideoScreen {
	constructor({ camera, parent, videos = {}, runtime = {} }) {
		this.camera = camera;
		this.videos = videos;
		this.dist = runtime.videoDistanceMetres ?? 1.35;
		this.fovDeg = runtime.videoFovDeg ?? 52;
		// How fast the panel catches up to the gaze, and how far it may drift before it tries.
		this.follow = runtime.videoFollowPerSec ?? 3.4;
		this.deadZoneDeg = runtime.videoDeadZoneDeg ?? 6;

		this.id = null;
		this.el = null;
		this.texture = null;
		// Per-clip playback position, so closing and reopening does not restart a lecture.
		this.resumeAt = new Map();
		this.elements = new Map();

		this.group = new THREE.Group();
		this.group.visible = false;
		parent.add(this.group);

		// Backdrop is wider than the video and sits just behind it: it masks the lesson so the
		// clip reads as a screen rather than a floating rectangle over the anatomy.
		this.backdrop = new THREE.Mesh(
			new THREE.PlaneGeometry(1, 1),
			new THREE.MeshBasicMaterial({ color: 0x05070a, transparent: true, opacity: 0.92 }),
		);
		this.backdrop.position.z = -0.012;
		this.screen = new THREE.Mesh(
			new THREE.PlaneGeometry(1, 1),
			// Unlit on purpose: a lit material would tint the footage with the room environment.
			new THREE.MeshBasicMaterial({ color: 0x000000 }),
		);
		this.group.add(this.backdrop, this.screen);

		this.closeBtn = makeButton({ label: 'Close  (trigger)', width: 0.3, height: 0.075, fontSize: 0.028 });
		// A room of 28 headsets playing the same narration out loud is unusable, so sound is
		// always one press away from off, and the label always states the CURRENT state.
		this.muteBtn = makeButton({ label: 'Mute', width: 0.19, height: 0.075, fontSize: 0.028 });
		this.group.add(this.closeBtn, this.muteBtn);
		// Set when the browser refused unmuted playback and we fell back to muted: the student
		// is told sound is off and one more press turns it on (that press is a fresh gesture).
		this.audioBlocked = false;

		this.caption = makeText({ fontSize: 0.03, maxWidth: 1.2, anchorX: 'center', anchorY: 'bottom', color: 0xffffff });
		this.group.add(this.caption);

		// Elapsed bar. Anchored by its left edge so it can be scaled from 0..1 without
		// recentring it every frame.
		this.barBack = new THREE.Mesh(
			new THREE.PlaneGeometry(1, 0.012),
			new THREE.MeshBasicMaterial({ color: 0x33414f }),
		);
		this.bar = new THREE.Mesh(
			new THREE.PlaneGeometry(1, 0.012),
			new THREE.MeshBasicMaterial({ color: 0x9fc2e0 }),
		);
		this.bar.geometry.translate(0.5, 0, 0);
		this.barBack.geometry.translate(0.5, 0, 0);
		this.group.add(this.barBack, this.bar);

		// A student who takes the headset off without closing the clip must not leave narration
		// playing to an empty room; the browser backgrounds the page in that case.
		this._onHide = () => {
			if (document.visibilityState === 'hidden') this.el?.pause();
		};
		document.addEventListener('visibilitychange', this._onHide);

		this._v = new THREE.Vector3();
		this._fwd = new THREE.Vector3();
		this._target = new THREE.Vector3();
		this._q = new THREE.Quaternion();
	}

	get isOpen() {
		return !!this.id;
	}

	/** Lazily build (and cache) the media element for a clip id. */
	elementFor(id) {
		if (this.elements.has(id)) return this.elements.get(id);
		const spec = this.videos[id];
		if (!spec) return null;
		const el = document.createElement('video');
		el.src = spec.src;
		el.loop = !!spec.loop;
		el.playsInline = true;
		el.crossOrigin = 'anonymous';
		// 'none' keeps the clip off the boot path entirely; it is fetched on first open.
		el.preload = 'none';
		// Clips are authored WITH sound. Browsers block unmuted autoplay unless the play call
		// is attributed to a user gesture; open() is always reached from a trigger press, so
		// this normally succeeds, and play() below degrades to muted rather than failing.
		el.muted = spec.muted ?? false;
		el.volume = spec.volume ?? 1;
		el.setAttribute('aria-hidden', 'true');
		el.style.display = 'none';
		document.body.appendChild(el);
		this.elements.set(id, el);
		return el;
	}

	/**
	 * Show a clip. `startSec` wins, then a remembered position, then the authored start.
	 * Returns false for an unknown id so a bad data line cannot break the lesson.
	 */
	open(id, startSec) {
		const spec = this.videos[id];
		const el = this.elementFor(id);
		if (!spec || !el) return false;
		if (this.id && this.id !== id) this.close();

		this.id = id;
		this.el = el;
		if (!this.texture || this.texture.image !== el) {
			this.texture?.dispose();
			this.texture = new THREE.VideoTexture(el);
			this.texture.colorSpace = THREE.SRGBColorSpace;
			this.screen.material.map = this.texture;
			this.screen.material.color.setHex(0xffffff);
			this.screen.material.needsUpdate = true;
		}

		const at = startSec ?? this.resumeAt.get(id) ?? spec.start ?? 0;
		const seek = () => {
			// Seeking before metadata exists throws in some browsers; duration tells us it is safe.
			if (Number.isFinite(el.duration) && el.duration > 0) el.currentTime = Math.min(at, el.duration - 0.05);
		};
		if (el.readyState >= 1) seek();
		else el.addEventListener('loadedmetadata', seek, { once: true });

		this.caption.text = spec.title || '';
		this.caption.sync();
		this.layout();
		this.group.visible = true;
		// Snap to the current gaze on open instead of easing in from wherever the last clip
		// was closed, which would fly the panel across the student's view.
		this.reposition(1);
		this.playWithFallback();
		return true;
	}

	/**
	 * Start playback, surviving autoplay policy. If sound is refused we retry muted so the
	 * student still sees the clip, and flag it so the UI can offer sound on the next press
	 * instead of silently losing the narration.
	 */
	playWithFallback() {
		const el = this.el;
		if (!el) return;
		el.play().then(
			() => {
				this.audioBlocked = false;
				this.syncAudioUi();
			},
			() => {
				el.muted = true;
				this.audioBlocked = true;
				this.syncAudioUi();
				el.play().catch(() => {
					// Even muted playback was refused. Leave the panel up on its current frame
					// rather than tearing the lesson down over a media policy.
				});
			},
		);
	}

	/** Keep the button label honest about what the next press will do. */
	syncAudioUi() {
		const label = this.audioBlocked ? 'Sound on' : this.el?.muted ? 'Unmute' : 'Mute';
		this.muteBtn.userData.caption.text = label;
		this.muteBtn.userData.caption.sync();
	}

	/** Toggle sound. Called from a trigger press, which is the gesture an unmute needs. */
	toggleMute() {
		if (!this.el) return false;
		this.el.muted = !this.el.muted;
		if (!this.el.muted) {
			this.audioBlocked = false;
			// The element may have been paused by the failed unmuted attempt.
			this.el.play().catch(() => {});
		}
		this.syncAudioUi();
		return true;
	}

	/** Hide the clip and remember where it got to. */
	close() {
		if (!this.id) return false;
		if (this.el) {
			this.resumeAt.set(this.id, this.el.currentTime || 0);
			this.el.pause();
		}
		this.id = null;
		this.el = null;
		this.group.visible = false;
		return true;
	}

	/** Size the quad from an angular spec so it fills the same share of view at any distance. */
	layout() {
		const h = 2 * this.dist * Math.tan(THREE.MathUtils.degToRad(this.fovDeg) / 2);
		const el = this.el;
		const aspect =
			el && el.videoWidth && el.videoHeight
				? el.videoWidth / el.videoHeight
				: this.videos[this.id]?.aspect ?? 16 / 9;
		const w = h * aspect;
		this.screen.scale.set(w, h, 1);
		this.backdrop.scale.set(w * 1.08, h * 1.22, 1);
		this.closeBtn.position.set(w / 2 - 0.17, -h / 2 - 0.055, 0.001);
		this.muteBtn.position.set(w / 2 - 0.17 - 0.26, -h / 2 - 0.055, 0.001);
		this.caption.position.set(0, h / 2 + 0.02, 0.001);
		this.barBack.position.set(-w / 2, -h / 2 - 0.016, 0.001);
		this.bar.position.set(-w / 2, -h / 2 - 0.016, 0.002);
		this.barBack.scale.x = w;
		this.screenW = w;
		this.screenH = h;
	}

	/** Ease the panel toward the gaze. `force` of 1 snaps it there immediately. */
	reposition(force = 0) {
		const cam = this.camera;
		// Camera and this group share a parent, so its local transform is the right space to
		// work in and no world-matrix round trip is needed.
		const camPos = this._v.copy(cam.position);
		const fwd = this._fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
		const target = this._target.copy(camPos).addScaledVector(fwd, this.dist);

		if (force >= 1) {
			this.group.position.copy(target);
			this.group.quaternion.copy(cam.quaternion);
			return;
		}
		// Dead zone measured as the angle between the gaze and the panel, so a small head
		// turn moves nothing and the image stays rock steady while reading.
		const toPanel = this.group.position.clone().sub(camPos);
		const drift = toPanel.lengthSq() > 1e-6 ? toPanel.normalize().angleTo(fwd) : Math.PI;
		if (drift > THREE.MathUtils.degToRad(this.deadZoneDeg)) {
			this.group.position.lerp(target, Math.min(1, force * this.follow));
		}
		this.group.quaternion.slerp(cam.quaternion, Math.min(1, force * this.follow));
	}

	/** Per-frame: follow the head and advance the progress bar. */
	update(dt) {
		if (!this.isOpen) return;
		// Aspect is only known once metadata has arrived, so re-layout until it settles.
		if (this.el?.videoWidth && Math.abs(this.screen.scale.x / this.screen.scale.y - this.el.videoWidth / this.el.videoHeight) > 0.01) {
			this.layout();
		}
		this.reposition(dt);
		const d = this.el?.duration;
		this.bar.scale.x = Number.isFinite(d) && d > 0 ? (this.el.currentTime / d) * this.screenW : 0;
	}

	/** Is the ray on the Close plate? */
	pickClose(ray) {
		if (!this.isOpen) return null;
		const hit = ray.intersectObject(this.closeBtn.userData.plate, false)[0];
		return hit ? { distance: hit.distance } : null;
	}

	/** Is the ray on the Mute plate? */
	pickMute(ray) {
		if (!this.isOpen) return null;
		const hit = ray.intersectObject(this.muteBtn.userData.plate, false)[0];
		return hit ? { distance: hit.distance } : null;
	}

	/** Is the ray anywhere on the panel? Used to swallow stray presses behind the video. */
	pickPanel(ray) {
		if (!this.isOpen) return null;
		const hit = ray.intersectObject(this.backdrop, false)[0];
		return hit ? { distance: hit.distance } : null;
	}

	state() {
		return {
			open: this.id,
			t: this.el ? +(this.el.currentTime || 0).toFixed(2) : null,
			paused: this.el ? this.el.paused : null,
			muted: this.el ? this.el.muted : null,
			audioBlocked: this.audioBlocked,
			resume: Object.fromEntries([...this.resumeAt].map(([k, v]) => [k, +v.toFixed(2)])),
		};
	}
}
