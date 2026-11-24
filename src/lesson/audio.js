/**
 * Drop MP3s in src/assets/audio named like tts-script.txt keys.
 * Prefers .mp3, then .wav / .ogg.
 *
 * A section `s1-orient.hs` plays every matching clip in order:
 *   s1-orient.hs.mp3
 *   s1-orient.hs_01.mp3
 *   s1-orient.hs_02.mp3
 * Stop at the first missing numbered file.
 */
const BASE = 'assets/audio';
const EXTS = ['mp3', 'wav', 'ogg'];
const MAX_PARTS = 20;

export function promptStems(stepId, band) {
	return [`${stepId}.${band}`, stepId];
}

export function introStems() {
	return ['intro'];
}

export function quizStems(quizIndex) {
	const n = quizIndex + 1;
	return [`quiz-${n}`];
}

export function feedbackStems(stepId, band) {
	return [`${stepId}.feedback.${band}`, `${stepId}.feedback`];
}

/** Stems for a "Find it: X" clip: `part.<id>`, with the ontology colon rendered as a dash. */
export function partStems(id) {
	return [`part.${String(id).replace(/:/g, '-')}`];
}

/** Stems for a flow-hop clip: `waypoint.<waypoint-id>`. */
export function waypointStems(id) {
	return [`waypoint.${id}`];
}

/** Stems for a vocab-definition clip: `vocab.<term>.<band>`, then the band-less file. */
export function vocabStems(term, band) {
	return band ? [`vocab.${term}.${band}`, `vocab.${term}`] : [`vocab.${term}`];
}

/** Stems for a quiz-explanation clip: `quiz-<n>.why`, n the 1-based quiz number. */
export function quizWhyStems(quizIndex) {
	return [`quiz-${quizIndex + 1}.why`];
}

/** Stems for a HUD chip clip: `hud.<name>` (play, passthrough, continue, restart, ...). */
export function hudStems(name) {
	return [`hud.${name}`];
}

/** Stems for the end-card clip: `done`. */
export function doneStems() {
	return ['done'];
}

/** Stems for the video-title clip: `video.title`. */
export function videoTitleStems() {
	return ['video.title'];
}

async function urlExists(url) {
	try {
		let r = await fetch(url, { method: 'HEAD' });
		if (r.status === 405 || r.status === 501) {
			r = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-1' } });
		}
		return r.ok;
	} catch {
		return false;
	}
}

// One element for the whole lesson. Unlock it on the ENTER VR click (real user
// gesture); later ClipBank.play() calls then survive Quest autoplay policy.
const mediaEl = new Audio();
mediaEl.preload = 'auto';

const SILENCE = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';

export function unlockMedia() {
	if (mediaEl.dataset.unlocked === '1') return;
	const had = mediaEl.src;
	if (!had) mediaEl.src = SILENCE;
	mediaEl.muted = true;
	const done = () => {
		mediaEl.pause();
		mediaEl.muted = false;
		mediaEl.currentTime = 0;
		mediaEl.dataset.unlocked = '1';
	};
	const p = mediaEl.play();
	if (p && p.then) p.then(done).catch(() => { mediaEl.muted = false; });
	else done();
}

export class ClipBank {
	constructor() {
		this.found = new Map();
		this.el = mediaEl;
		this.queue = null;
		this.qi = 0;
	}

	async locate(stems) {
		for (const stem of stems) {
			const urls = [];
			const bare = await this.probe(stem);
			if (bare) urls.push(bare);
			for (let i = 1; i <= MAX_PARTS; i++) {
				const part = await this.probe(`${stem}_${String(i).padStart(2, '0')}`);
				if (!part) break;
				urls.push(part);
			}
			if (urls.length) return urls;
		}
		return [];
	}

	async probe(stem) {
		if (this.found.has(stem)) return this.found.get(stem);
		let url = null;
		for (const ext of EXTS) {
			const tryUrl = `${BASE}/${stem}.${ext}`;
			if (await urlExists(tryUrl)) {
				url = tryUrl;
				break;
			}
		}
		this.found.set(stem, url);
		return url;
	}

	play(urls) {
		const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
		if (!list.length) return false;
		const same = this.queue && this.queue.length === list.length && this.queue.every((u, i) => u === list[i]);
		if (same && !this.el.paused) {
			this.stop();
			return true;
		}
		this.stop();
		this.queue = list;
		this.qi = 0;
		this.el.onended = () => this.next();
		this.startCurrent();
		return true;
	}

	startCurrent() {
		const url = this.queue?.[this.qi];
		if (!url) {
			this.stop();
			return;
		}
		this.el.src = url;
		this.el.play().catch(() => this.next());
	}

	next() {
		this.qi += 1;
		if (!this.queue || this.qi >= this.queue.length) {
			this.stop();
			return;
		}
		this.startCurrent();
	}

	stop() {
		this.el.onended = null;
		this.el.pause();
		this.el.currentTime = 0;
		this.queue = null;
		this.qi = 0;
	}
}
