// Lesson content <-> anatomy registry cross-check.
// Run: node tools/validate-lesson.mjs [lesson.json] [parts.json]
// Exits 1 on any reference that does not resolve, and reports objective coverage.
import fs from 'node:fs';

const lessonPath = process.argv[2] || 'src/lessons/heart.json';
const regPath = process.argv[3] || 'src/assets/anatomy/parts.json';

const L = JSON.parse(fs.readFileSync(lessonPath, 'utf8'));
const R = JSON.parse(fs.readFileSync(regPath, 'utf8'));
const ids = new Map(R.parts.map(p => [p.id, p]));
const errs = [], warns = [];

const need = (id, where) => { if (!ids.has(id)) errs.push(`${where}: unknown part id ${id}`); };

// tiers must cover the registry exactly
const tierIds = [...L.tiers.core, ...L.tiers.detail];
tierIds.forEach(id => need(id, 'tiers'));
const tierSet = new Set(tierIds);
R.parts.forEach(p => { if (!tierSet.has(p.id)) warns.push(`registry part not in any tier: ${p.id} (${p.label})`); });
if (tierIds.length !== new Set(tierIds).size) errs.push('tiers contain duplicate ids');

// flow path
L.flow.order.forEach((s, i) => {
  if (s.kind === 'part') need(s.id, `flow[${i}]`);
  else if (s.anchor) need(s.anchor, `flow[${i}] waypoint ${s.id}`);
});
const flowParts = L.flow.order.filter(s => s.kind === 'part').map(s => s.id);
if (new Set(flowParts).size !== flowParts.length) errs.push('flow path repeats a part');

// step actions + vocab + misconceptions
L.steps.forEach(s => {
  (s.action?.isolate || []).forEach(id => need(id, `step ${s.id} isolate`));
  (s.action?.ghost || []).forEach(id => need(id, `step ${s.id} ghost`));
  if (!L.objectives.some(o => o.id === s.outcome)) errs.push(`step ${s.id} cites unknown objective ${s.outcome}`);
  if (!s.prompt.hs || !s.prompt.ms) errs.push(`step ${s.id} is missing one level register (hs/ms)`);
});
L.vocab.forEach(v => v.ids.forEach(id => need(id, `vocab ${v.term}`)));
L.misconceptions.forEach(m => {
  if (!L.objectives.some(o => o.id === m.outcome)) errs.push(`misconception "${m.claim}" cites unknown objective`);
  if (!m.source) warns.push(`misconception "${m.claim}" has no source citation`);
  if (!m.step) warns.push(`misconception "${m.claim}" is attached to no step, so it never gets taught`);
  else if (!L.steps.some(s => s.id === m.step)) errs.push(`misconception "${m.claim}" cites unknown step ${m.step}`);
});
L.quiz.forEach((q, i) => {
  if (q.answer < 0 || q.answer >= q.choices.length) errs.push(`quiz[${i}] answer index out of range`);
  if (!q.source) warns.push(`quiz[${i}] has no source citation`);
});

// coverage: every objective should be touched by a step and checked by a quiz-ish item
const taught = new Set([...L.steps.map(s => s.outcome),
  ...L.misconceptions.filter(m => m.step).map(m => m.outcome)]);
const checked = new Set([...L.steps.map(s => s.outcome), ...L.misconceptions.map(m => m.outcome)]);
L.objectives.forEach(o => {
  if (!taught.has(o.id)) warns.push(`objective ${o.id} is never taught by a step`);
  if (!checked.has(o.id)) warns.push(`objective ${o.id} is never checked`);
});

// reading-load signal for headset text (no line breaks while wearing a headset in a noisy room)
const longPrompt = L.steps.filter(s => (s.prompt.hs || '').split(' ').length > 34);
if (longPrompt.length) warns.push(`prompts over 34 words (hard to read in-headset): ${longPrompt.map(s => s.id).join(', ')}`);

const minutes = L.steps.reduce((a, s) => a + s.minutes, 0);
console.log(`lesson ${L.id}: ${L.steps.length} steps, ${minutes} min (declared ${L.timeMinutes.core})`);
console.log(`registry ${ids.size} parts | tiers core ${L.tiers.core.length} + detail ${L.tiers.detail.length} | flow ${L.flow.order.length} steps (${flowParts.length} real parts) | quiz ${L.quiz.length}`);
if (minutes > L.timeMinutes.core) warns.push(`step minutes sum ${minutes} exceeds declared core time ${L.timeMinutes.core}`);

warns.forEach(w => console.log('WARN ' + w));
errs.forEach(e => console.log('ERROR ' + e));
console.log(errs.length ? 'FAIL' : 'OK');
process.exit(errs.length ? 1 : 0);
