#!/usr/bin/env node
/**
 * Make a Substance 3D Painter glTF export loadable by the lesson.
 *
 *   node tools/painter-glb-fix.mjs <painter-export.glb> <original-source.glb> <out.glb>
 *
 * Painter's glTF export wraps every mesh node in a group node with the SAME name
 * (VH_M_mitral_valve > VH_M_mitral_valve). three.js de-duplicates names on load, so the
 * mesh arrives as `VH_M_mitral_valve_1` and the registry (parts.json, keyed by mesh name)
 * matches 0 of 14 parts - the heart loads with nothing selectable. The export also drops
 * every node's `extras` (the UBERON ontology ids that `npm run parts` reads).
 *
 * This tool rewrites only the GLB's JSON chunk; the binary chunk (geometry, UVs,
 * tangents, embedded textures) is copied through byte for byte:
 *   1. A wrapper group that shares its child mesh's name is renamed `<name>__group`, so the
 *      mesh keeps the exact name the registry expects. Wrappers are left in place rather than
 *      collapsed: the loader measures explode directions in each mesh's PARENT space, and a
 *      rename cannot change a transform.
 *   2. `extras` are copied back from the original source file, matched by node name.
 * It refuses to write a file whose node names are still not unique, or whose wrappers carry
 * a non-identity transform it did not expect.
 * Zero dependencies on purpose: it has to run on a teacher's laptop with only Node.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [, , inPath, srcPath, outPath] = process.argv;
if (!inPath || !srcPath || !outPath) {
	console.error('usage: node tools/painter-glb-fix.mjs <painter-export.glb> <original-source.glb> <out.glb>');
	process.exit(2);
}

function readGlb(path) {
	const buf = readFileSync(path);
	if (buf.toString('ascii', 0, 4) !== 'glTF') throw new Error(`${path}: not a GLB`);
	const jsonLen = buf.readUInt32LE(12);
	if (buf.toString('ascii', 16, 20) !== 'JSON') throw new Error(`${path}: first chunk is not JSON`);
	const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
	const rest = buf.subarray(20 + jsonLen); // BIN chunk header + data, untouched
	return { json, rest };
}

function writeGlb(path, json, rest) {
	let text = Buffer.from(JSON.stringify(json), 'utf8');
	const pad = (4 - (text.length % 4)) % 4;
	if (pad) text = Buffer.concat([text, Buffer.alloc(pad, 0x20)]); // spec: pad JSON with spaces
	const header = Buffer.alloc(12);
	const chunk = Buffer.alloc(8);
	chunk.writeUInt32LE(text.length, 0);
	chunk.write('JSON', 4, 'ascii');
	const total = 12 + 8 + text.length + rest.length;
	header.write('glTF', 0, 'ascii');
	header.writeUInt32LE(2, 4);
	header.writeUInt32LE(total, 8);
	writeFileSync(path, Buffer.concat([header, chunk, text, rest]));
	return total;
}

const isIdentity = (n) =>
	!n.matrix &&
	(n.translation ?? [0, 0, 0]).every((v) => Math.abs(v) < 1e-9) &&
	(n.rotation ?? [0, 0, 0, 1]).every((v, i) => Math.abs(v - (i === 3 ? 1 : 0)) < 1e-9) &&
	(n.scale ?? [1, 1, 1]).every((v) => Math.abs(v - 1) < 1e-9);

const painted = readGlb(inPath);
const source = readGlb(srcPath);
const nodes = painted.json.nodes;

const parentOf = new Map();
nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parentOf.set(c, i)));

let renamed = 0;
nodes.forEach((n, i) => {
	if (n.mesh === undefined) return;
	const p = parentOf.get(i);
	if (p === undefined) return;
	const parent = nodes[p];
	if (parent.name !== n.name || parent.mesh !== undefined) return;
	if (!isIdentity(parent))
		throw new Error(`wrapper "${parent.name}" has a transform; refusing to guess - re-export or fix by hand`);
	parent.name = `${parent.name}__group`;
	renamed += 1;
});

const extrasByName = new Map(source.json.nodes.filter((n) => n.extras).map((n) => [n.name, n.extras]));
let restored = 0;
for (const n of nodes) {
	const e = extrasByName.get(n.name);
	if (!e) continue;
	n.extras = { ...e, ...(n.extras ?? {}) };
	restored += 1;
}

const names = nodes.map((n) => n.name).filter(Boolean);
const dupes = names.filter((n, i) => names.indexOf(n) !== i);
if (dupes.length) throw new Error(`node names still not unique: ${[...new Set(dupes)].join(', ')}`);

painted.json.asset = { ...painted.json.asset, extras: { ...(painted.json.asset.extras ?? {}), fixedBy: 'tools/painter-glb-fix.mjs' } };
const bytes = writeGlb(outPath, painted.json, painted.rest);
console.log(`wrappers renamed: ${renamed}, extras restored: ${restored}/${extrasByName.size}, wrote ${bytes} bytes -> ${outPath}`);
