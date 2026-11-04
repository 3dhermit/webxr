// crosswalk CSV + GLB node geometry -> parts.json registry (anatomy as data).
// Run: node parts-gen.mjs <glb> <crosswalk.csv> <out.json>
import fs from 'node:fs';
const [glbPath, csvPath, outPath] = process.argv.slice(2);

const buf = fs.readFileSync(glbPath);
const g = JSON.parse(buf.slice(20, 20 + buf.readUInt32LE(12)).toString('utf8'));
const acc = g.accessors, nodes = g.nodes;

// --- tiny mat4 helpers (column-major, glTF order) ---
const mul = (a, b) => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
};
const TRS = (n) => {
  if (n.matrix) return n.matrix.slice();
  const t = n.translation || [0, 0, 0], s = n.scale || [1, 1, 1];
  let m = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  const q = n.rotation;
  if (q) { const [x,y,z,w]=q;
    m = [1-2*(y*y+z*z),2*(x*y+z*w),2*(x*z-y*w),0, 2*(x*y-z*w),1-2*(x*x+z*z),2*(y*z+x*w),0,
         2*(x*z+y*w),2*(y*z-x*w),1-2*(x*x+y*y),0, 0,0,0,1];
  }
  for (let c = 0; c < 3; c++) for (let r = 0; r < 4; r++) m[c * 4 + r] *= s[c];
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2];
  return m;
};
const xform = (m, p) => [
  m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12],
  m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13],
  m[2]*p[0]+m[6]*p[1]+m[10]*p[2]+m[14],
];

// world matrix per node: walk down from every node that is nobody's child
const world = new Array(nodes.length).fill(null);
const walk = (i, parent) => {
  world[i] = parent ? mul(parent, TRS(nodes[i])) : TRS(nodes[i]);
  (nodes[i].children || []).forEach((c) => walk(c, world[i]));
};
const childSet = new Set();
nodes.forEach((n) => (n.children || []).forEach((c) => childSet.add(c)));
const parentOf = {};
nodes.forEach((n, i) => (n.children || []).forEach((c) => (parentOf[c] = i)));
nodes.forEach((n, i) => { if (!childSet.has(i)) walk(i, null); });

// per-part world bbox centre + extent
function partGeom(i) {
  const mesh = g.meshes[nodes[i].mesh];
  let lo = [Infinity,Infinity,Infinity], hi = [-Infinity,-Infinity,-Infinity];
  for (const p of mesh.primitives) {
    const a = acc[p.attributes.POSITION];
    for (const c of [[a.min[0],a.min[1],a.min[2]], [a.max[0],a.max[1],a.max[2]],
                     [a.min[0],a.min[1],a.max[2]], [a.max[0],a.max[1],a.min[2]],
                     [a.min[0],a.max[1],a.min[2]], [a.max[0],a.min[1],a.max[2]],
                     [a.min[0],a.max[1],a.max[2]], [a.max[0],a.max[1],a.min[2]]]) {
      const w = xform(world[i], c);
      for (let k = 0; k < 3; k++) { lo[k]=Math.min(lo[k],w[k]); hi[k]=Math.max(hi[k],w[k]); }
    }
  }
  return { center: lo.map((v,k)=>+(v+hi[k])/2), size: hi.map((v,k)=>+(v-lo[k]).toFixed(4)), tris: mesh.primitives.reduce((t,p)=>t+Math.floor((acc[p.indices].count||0)/3),0) };
}

// --- crosswalk ---
const rows = fs.readFileSync(csvPath,'utf8').split(/\r?\n/).filter(Boolean);
const head = rows[0].split(',');
const recs = rows.slice(1).map((r) => { const v=r.split(','); return Object.fromEntries(head.map((h,k)=>[h.trim(),v[k]])); });

// anatomical bias: which way this kind of part separates (model +Y is superior)
const AXIS = { valve:[0,1,0], atrium:[0,1,-1], ventricle:[0,-1,0], septum:[-1,0,0],
               chamber:[0,0,-1], papillary:[0,-1,0], default:[0,0,-1] };
const SYSTEM = { valve:'valve', atrium:'chamber', ventricle:'chamber', septum:'wall',
                 chamber:'chamber', papillary:'support', heart:'organ' };
function kind(label){ const l=label.toLowerCase();
  return Object.keys(AXIS).find(k=>l.includes(k)) || 'default'; }

// model centroid from all meshed nodes
const all = nodes.map((n,i)=> n.mesh==null ? null : partGeom(i).center).filter(Boolean);
const C = [0,1,2].map(k=>all.reduce((s,c)=>s+c[k],0)/all.length);

const parts = [];
for (const r of recs) {
  const i = nodes.findIndex(n=>n.name===r.node_name);
  if (i<0) { console.log('MISSING node for crosswalk row:', r.node_name); continue; }
  if (nodes[i].mesh==null) { console.log('group node (no mesh):', r.node_name); continue; }
  const ex = nodes[i].extras || {};
  const gm = partGeom(i), k = kind(ex.label || r.label || r.node_name);
  let v = gm.center.map((c,j)=>c-C[j]);                       // radial component
  const ax = AXIS[k];
  v = v.map((x,j)=>x*0.45 + ax[j]*0.55);                      // blend in anatomical axis
  const len = Math.hypot(...v) || 1;
  const out = v.map(x=>+(x/len).toFixed(3));
  const span = Math.max(...gm.size);
  const grp = parentOf[i]==null ? '' : (nodes[parentOf[i]].name||'');
  const sys = /chamber/.test(grp)?'chamber':/valve/.test(grp)?'valve'
            : /papillary/.test(grp)?'support':(SYSTEM[k]||'organ');
  parts.push({ id:(ex.ontologyid||r.OntologyID||'').trim(), mesh:r.node_name,
    label:(ex.label||r.label||r.node_name), system:sys,
    center:gm.center.map(x=>+x.toFixed(4)), size:gm.size,
    triangles:gm.tris, out, spread:+(0.12 + span * 2).toFixed(3),
    fact:'', quiz:'' });
}
// --- auto-explode solver: grow each part's spread until no pair overlaps ---
// Each part can only move along its own `out` axis, so the required separation is
// projected onto that axis. Bounded iterations; leftovers are the hand-tune list.
const R = parts.map(p => Math.hypot(...p.size) / 2);
const dot = (u, v) => u.reduce((s, x, i) => s + x * v[i], 0);
const place = (p) => p.center.map((c, i) => c + p.out[i] * p.spread);
const PAD = 0.004; // 4 mm clearance
function measure() {
  let overlaps = 0, worst = 1, worstPair = '';
  for (let a = 0; a < parts.length; a++) for (let b = a + 1; b < parts.length; b++) {
    const pa = place(parts[a]), pb = place(parts[b]);
    const d = Math.hypot(...pb.map((x, i) => x - pa[i]));
    const ratio = d / (R[a] + R[b] + PAD);
    if (ratio < 1) { overlaps++; if (ratio < worst) { worst = ratio; worstPair = `${parts[a].label} <-> ${parts[b].label}`; } }
  }
  return { overlaps, worst: +worst.toFixed(3), worstPair };
}
const before = measure();
function relax(iters) {
  for (let it = 0; it < iters; it++) {
    let moved = false;
    for (let a = 0; a < parts.length; a++) for (let b = a + 1; b < parts.length; b++) {
      const pa = place(parts[a]), pb = place(parts[b]);
      const v = pb.map((x, i) => x - pa[i]);
      const d = Math.hypot(...v) || 1e-6;
      const need = R[a] + R[b] + PAD;
      if (d >= need) continue;
      const dir = v.map((x) => x / d), push = (need - d) / 2;
      parts[a].spread = Math.min(0.35, Math.max(0.01, parts[a].spread - dot(dir, parts[a].out) * push));
      parts[b].spread = Math.min(0.35, Math.max(0.01, parts[b].spread + dot(dir, parts[b].out) * push));
      moved = true;
    }
    if (!moved) break;
  }
}
relax(200);
// Phase 2: a pair that cannot clear along its existing axes gets its axes blended toward
// the line joining the two parts (side-by-side parts separate along their mutual axis),
// then spreads relax again. This is what fixes e.g. the aortic/pulmonary valve pair.
const unit = (u) => { const l = Math.hypot(...u) || 1; return u.map((x) => x / l); };
for (let round = 0; round < 8; round++) {
  let changed = false;
  for (let a = 0; a < parts.length; a++) for (let b = a + 1; b < parts.length; b++) {
    const pa = place(parts[a]), pb = place(parts[b]);
    const v = pb.map((x, i) => x - pa[i]);
    const d = Math.hypot(...v) || 1e-6;
    if (d >= R[a] + R[b] + PAD) continue;
    const dir = v.map((x) => x / d);
    parts[a].out = unit(parts[a].out.map((x, i) => x - dir[i] * 0.6));
    parts[b].out = unit(parts[b].out.map((x, i) => x + dir[i] * 0.6));
    changed = true;
  }
  if (!changed) break;
  relax(60);
}
const after = measure();
parts.forEach((p) => { p.spread = +p.spread.toFixed(3); p.out = p.out.map((x) => +x.toFixed(3)); });

parts.sort((a,b)=>b.triangles-a.triangles);
fs.writeFileSync(outPath, JSON.stringify({ source:'HuBMAP Human Reference Atlas heart-male v1.3, CC BY 4.0',
  model:'src/assets/anatomy/heart-male.opt.glb', modelCenter:C.map(x=>+x.toFixed(4)),
  totalTriangles:parts.reduce((s,p)=>s+p.triangles,0),
  explodeSolve:{ parts:parts.length, pairs:parts.length*(parts.length-1)/2,
    overlapBefore:before.overlaps, overlapAfter:after.overlaps,
    minSeparationRatio:before.worst, clearanceAfter:after.worst }, parts }, null, 2));
console.log('parts:', parts.length, '| tris:', parts.reduce((s,p)=>s+p.triangles,0),
  '| solver: overlapping pairs', before.overlaps, '->', after.overlaps,
  '| min separation', before.worst, '->', after.worst, after.worstPair ? ('(tightest: '+after.worstPair+')') : '');
console.log(parts.map(p=>`${String(p.triangles).padStart(6)}  ${p.system.padEnd(8)} ${p.label.padEnd(46)} ${p.id.padEnd(14)} out[${p.out}] x${p.spread}`).join('\n'));
