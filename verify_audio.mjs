// Dry-run: resolve every clip stem the lesson will request against the real audio dir.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	feedbackStems, partStems, waypointStems, vocabStems, quizWhyStems, hudStems, doneStems, videoTitleStems,
} from './src/lesson/audio.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const dir = here + 'src/assets/audio/';
const level = JSON.parse(readFileSync(here + 'src/lessons/heart.json', 'utf8')).defaultLevel;
const data = JSON.parse(readFileSync(here + 'src/lessons/heart.json', 'utf8'));

const s = {};
for (const m of data.misconceptions || []) s[`feedback:${m.step}`] = feedbackStems(m.step, level);
for (const id of data.tiers?.core || []) s[`part:${id}`] = partStems(id);
for (const hop of data.flow?.order || []) if (hop.kind === 'waypoint') s[`waypoint:${hop.id}`] = waypointStems(hop.id);
for (const v of data.vocab || []) s[`vocab:${v.term}`] = vocabStems(v.term, level);
(data.quiz || []).forEach((_, n) => (s[`quiz-why:${n}`] = quizWhyStems(n)));
for (const name of ['play', 'passthrough', 'continue', 'restart', 'restart-confirm', 'yes', 'no']) s[`hud:${name}`] = hudStems(name);
s['done'] = doneStems();
s['video-title'] = videoTitleStems();

let ok = 0, missing = 0;
for (const [key, stems] of Object.entries(s)) {
	const found = stems
		.flatMap((st) => [`${st}.mp3`, `${st}_01.mp3`, `${st}_00001.mp3`])
		.find((f) => existsSync(dir + f));
	if (found) { ok++; console.log(`OK   ${key.padEnd(24)} ${found}`); }
	else { missing++; console.log(`MISS ${key.padEnd(24)} tried: ${stems.join(', ')}`); }
}

// Orphans: mp3s no hook can request.
const requested = new Set();
for (const stems of Object.values(s)) for (const st of stems) for (const f of [`${st}.mp3`, `${st}_01.mp3`, `${st}_00001.mp3`]) requested.add(f);
const orphans = readdirSync(dir).filter((f) => f.endsWith('.mp3') && !requested.has(f));
console.log(`\nresolved ok=${ok} missing=${missing}`);
console.log('orphans (unused clips):', orphans.length ? orphans : 'none');
