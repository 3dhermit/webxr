/**
 * Teacher-editable lesson copy. Parsed from assets/audio/tts-script.txt.
 * Headers `name_01`, `name_02` join in order for on-screen text and audio.
 */
const SCRIPT_URL = 'assets/audio/tts-script.txt';

export function splitScriptKey(name) {
	const m = String(name || '').trim().match(/^(.*)_(\d{2})$/);
	if (m) return { base: m[1], part: Number(m[2]) };
	return { base: String(name || '').trim(), part: 0 };
}

export function parseLessonScript(text) {
	const blocks = new Map();
	let current = null;
	let buf = [];
	const flush = () => {
		if (!current) return;
		const { base, part } = splitScriptKey(current);
		const body = buf.join('\n').trim();
		current = null;
		buf = [];
		if (!base || !body) return;
		if (!blocks.has(base)) blocks.set(base, []);
		blocks.get(base).push({ part, body });
	};
	for (const line of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
		const m = line.match(/^---\s*(.+?)\s*---\s*$/);
		if (m) {
			flush();
			current = m[1].trim();
			buf = [];
			continue;
		}
		if (current) buf.push(line);
	}
	flush();
	const out = new Map();
	for (const [base, items] of blocks) {
		items.sort((a, b) => a.part - b.part);
		out.set(base, items.map((x) => x.body));
	}
	return out;
}

export async function loadLessonScript(url = SCRIPT_URL) {
	try {
		const r = await fetch(url);
		if (!r.ok) return new Map();
		return parseLessonScript(await r.text());
	} catch {
		return new Map();
	}
}

export function scriptJoin(map, ...keys) {
	if (!map) return '';
	for (const k of keys) {
		const parts = map.get(k);
		if (parts?.length) return parts.join('\n\n');
	}
	return '';
}
