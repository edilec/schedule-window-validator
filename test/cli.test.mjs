import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = new URL('../bin/schedule-window-validator.mjs', import.meta.url).pathname;
const hours = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [i, [{ start: '09:00', end: '17:00' }]]));
const policy = { timeZone: 'UTC', hours, holidays: [] };
const good = { jobs: [{ id: 'private', startUtc: '2026-01-05T10:00:00Z', endUtc: '2026-01-05T11:00:00Z', dependsOn: [] }] };
async function run(schedule = good, config = policy, extra = []) {
  const root = await mkdtemp(join(tmpdir(), 'window-test-'));
  await writeFile(join(root, 'schedule.json'), typeof schedule === 'string' ? schedule : JSON.stringify(schedule));
  await writeFile(join(root, 'policy.json'), typeof config === 'string' ? config : JSON.stringify(config));
  const p = spawnSync(process.execPath, [cli, '--root', root, '--schedule', 'schedule.json', '--policy', 'policy.json', ...extra], { encoding: 'utf8', maxBuffer: 4_194_304 });
  await rm(root, { recursive: true, force: true });
  return { code: p.status, stdout: p.stdout, stderr: p.stderr, report: p.stdout ? JSON.parse(p.stdout) : null };
}
test('good exported schedule passes with no private identity in JSON', async () => {
  const r = await run(); assert.equal(r.code, 0); assert.equal(r.report.status, 'pass');
  assert.equal(r.report.summary.checked, 1); assert.equal(r.stdout.includes('private'), false);
});
test('job outside hours fails at its source ordinal', async () => {
  const d = structuredClone(good); d.jobs[0].startUtc = '2026-01-05T08:00:00Z';
  const r = await run(d); assert.equal(r.code, 1); assert.equal(r.report.status, 'fail');
  assert.equal(r.report.findings[0].ruleId, 'outside-hours'); assert.equal(r.report.findings[0].location.pointer, '/jobs/0');
});
test('malformed schedule is incomplete without echoing its snippet', async () => {
  const r = await run('at position 1'); assert.equal(r.code, 2); assert.equal(r.report.status, 'incomplete');
  assert.equal(r.report.findings[0].ruleId, 'input-unreadable'); assert.equal(r.stdout.includes('at position 1'), false);
});
test('invalid policy is configuration error with empty stdout', async () => {
  const r = await run(good, { ...policy, timeZone: 'Not/AZone' });
  assert.equal(r.code, 2); assert.equal(r.stdout, '');
});
test('strict UTF-8 input refuses invalid byte', async () => {
  const root = await mkdtemp(join(tmpdir(), 'window-utf8-'));
  await writeFile(join(root, 'schedule.json'), Buffer.from([0xff]));
  await writeFile(join(root, 'policy.json'), JSON.stringify(policy));
  const p = spawnSync(process.execPath, [cli, '--root', root, '--schedule', 'schedule.json', '--policy', 'policy.json'], { encoding: 'utf8' });
  assert.equal(p.status, 2); assert.equal(JSON.parse(p.stdout).findings[0].ruleId, 'input-unreadable');
  await rm(root, { recursive: true, force: true });
});
test('input symlink outside root is refused without leaking target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'window-root-')), outside = await mkdtemp(join(tmpdir(), 'window-out-'));
  await writeFile(join(outside, 'secret.json'), 'secret-value');
  await symlink(join(outside, 'secret.json'), join(root, 'schedule.json'));
  await writeFile(join(root, 'policy.json'), JSON.stringify(policy));
  const p = spawnSync(process.execPath, [cli, '--root', root, '--schedule', 'schedule.json', '--policy', 'policy.json'], { encoding: 'utf8' });
  assert.equal(p.status, 2); assert.equal(JSON.parse(p.stdout).status, 'incomplete'); assert.equal(p.stdout.includes('secret-value'), false);
  await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true });
});
test('ordinary output file matches stdout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'window-report-'));
  await writeFile(join(root, 'schedule.json'), JSON.stringify(good)); await writeFile(join(root, 'policy.json'), JSON.stringify(policy));
  const p = spawnSync(process.execPath, [cli, '--root', root, '--schedule', 'schedule.json', '--policy', 'policy.json', '--out', 'report.json'], { encoding: 'utf8' });
  assert.equal(p.status, 0); assert.equal(await readFile(join(root, 'report.json'), 'utf8'), p.stdout);
  await rm(root, { recursive: true, force: true });
});
test('byte bound accepts 1048576 and rejects 1048577', async () => {
  const base = JSON.stringify(good), exact = base + ' '.repeat(1_048_576 - Buffer.byteLength(base));
  const at = await run(exact), over = await run(exact + ' ');
  assert.equal(at.code, 0); assert.equal(over.code, 2); assert.equal(over.report.findings[0].ruleId, 'byte-limit');
});
test('depth bound accepts 16 and rejects 17', async () => {
  const nested = n => { const d = structuredClone(good); let node = d; for (let i = 0; i < n; i++) { node.extra = {}; node = node.extra; } return d; };
  const at = await run(nested(16)), over = await run(nested(17));
  assert.equal(at.code, 0); assert.equal(over.code, 2); assert.equal(over.report.findings[0].ruleId, 'depth-limit');
});
test('job record bound accepts 1000 and rejects 1001', async () => {
  const d = { jobs: Array.from({ length: 1000 }, (_, i) => ({ ...good.jobs[0], id: String(i), endUtc: '2026-01-05T10:01:00Z' })) };
  const at = await run(d); assert.equal(at.code, 0); assert.equal(at.report.summary.checked, 1000);
  d.jobs.push({ ...good.jobs[0], id: 'extra' });
  const over = await run(d); assert.equal(over.code, 2); assert.equal(over.report.findings[0].ruleId, 'record-limit');
});
test('report output refuses hard link to policy input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'window-hardlink-'));
  const source = JSON.stringify(policy);
  try {
    await writeFile(join(root, 'schedule.json'), JSON.stringify(good)); await writeFile(join(root, 'policy.json'), source);
    await link(join(root, 'policy.json'), join(root, 'report.json'));
    const p = spawnSync(process.execPath, [cli, '--root', root, '--schedule', 'schedule.json', '--policy', 'policy.json', '--out', 'report.json'], { encoding: 'utf8' });
    assert.equal(p.status, 2); assert.equal(p.stdout, '');
    assert.equal(await readFile(join(root, 'policy.json'), 'utf8'), source);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('report output refuses symlink destination and symlinked parent escape', async () => {
  const root = await mkdtemp(join(tmpdir(), 'window-symlink-root-')), outside = await mkdtemp(join(tmpdir(), 'window-symlink-out-'));
  try {
    await writeFile(join(root, 'schedule.json'), JSON.stringify(good)); await writeFile(join(root, 'policy.json'), JSON.stringify(policy));
    await writeFile(join(outside, 'sentinel.json'), 'sentinel');
    await symlink(join(outside, 'sentinel.json'), join(root, 'report.json'));
    const args = [cli, '--root', root, '--schedule', 'schedule.json', '--policy', 'policy.json', '--out'];
    const direct = spawnSync(process.execPath, [...args, 'report.json'], { encoding: 'utf8' });
    assert.equal(direct.status, 2); assert.equal(direct.stdout, '');
    await symlink(outside, join(root, 'linked'));
    const parent = spawnSync(process.execPath, [...args, 'linked/sentinel.json'], { encoding: 'utf8' });
    assert.equal(parent.status, 2); assert.equal(parent.stdout, '');
    assert.equal(await readFile(join(outside, 'sentinel.json'), 'utf8'), 'sentinel');
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
test('report output cannot create missing schedule through in-root alias', async () => {
  const root = await mkdtemp(join(tmpdir(), 'window-alias-'));
  try {
    await writeFile(join(root, 'policy.json'), JSON.stringify(policy)); await symlink(root, join(root, 'alias'));
    const p = spawnSync(process.execPath, [cli, '--root', root, '--schedule', 'missing.json', '--policy', 'policy.json', '--out', 'alias/missing.json'], { encoding: 'utf8' });
    assert.equal(p.status, 2); assert.equal(p.stdout, '');
    await assert.rejects(readFile(join(root, 'missing.json')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
