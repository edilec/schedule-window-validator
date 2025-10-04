import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_ID, validateSchedule, ConfigError } from '../src/index.mjs';

const hours = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
const job = (id, startUtc, endUtc, extra = {}) => ({ id, startUtc, endUtc, dependsOn: [], ...extra });

test('good overnight job uses the Friday window into Saturday without a false finding', () => {
  const policy = { timeZone: 'America/New_York', hours: { ...hours, 5: [{ start: '22:00', end: '02:00' }] }, holidays: [] };
  const report = validateSchedule({ jobs: [job('private', '2026-01-03T04:00:00Z', '2026-01-03T06:00:00Z')] }, policy);
  assert.equal(TOOL_ID, 'schedule-window-validator');
  assert.equal(report.status, 'pass');
  assert.deepEqual(report.findings, []);
  assert.equal(report.summary.checked, 1);
  assert.equal(JSON.stringify(report).includes('private'), false);
});

test('spring-forward DST gap is absent from real UTC-minute expansion', () => {
  const policy = { timeZone: 'America/New_York', hours: { ...hours, 0: [{ start: '01:00', end: '04:00' }] }, holidays: [] };
  const report = validateSchedule({ jobs: [job('private', '2026-03-08T06:30:00Z', '2026-03-08T07:30:00Z')] }, policy);
  assert.equal(report.status, 'pass');
  assert.deepEqual(report.findings, []);
});

test('a required dependency finishing after the job starts blocks the schedule', () => {
  const policy = { timeZone: 'UTC', hours: { ...hours, 1: [{ start: '09:00', end: '17:00' }] }, holidays: [] };
  const report = validateSchedule({ jobs: [
    job('upstream', '2026-01-05T09:00:00Z', '2026-01-05T10:00:00Z'),
    job('downstream', '2026-01-05T09:30:00Z', '2026-01-05T11:00:00Z', { dependsOn: ['upstream'] }),
  ] }, policy);
  assert.equal(report.status, 'fail');
  assert.deepEqual(report.findings.map(x => x.ruleId), ['dependency-late']);
  assert.equal(report.findings[0].location.pointer, '/jobs/1/dependsOn/0');
});
test('fall-back repeated local hour is allowed in both UTC occurrences', () => {
  const policy = { timeZone: 'America/New_York', hours: { ...hours, 0: [{ start: '01:00', end: '02:00' }] }, holidays: [] };
  const report = validateSchedule({ jobs: [job('a', '2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z')] }, policy);
  assert.equal(report.status, 'pass'); assert.deepEqual(report.findings, []);
});
test('local holiday blocks an otherwise valid operating window', () => {
  const policy = { timeZone: 'UTC', hours: { ...hours, 1: [{ start: '09:00', end: '17:00' }] }, holidays: ['2026-01-05'] };
  const report = validateSchedule({ jobs: [job('private', '2026-01-05T10:00:00Z', '2026-01-05T11:00:00Z')] }, policy);
  assert.equal(report.status, 'fail'); assert.deepEqual(report.findings.map(x => x.ruleId), ['holiday-blocked']);
});
test('job ending after its deadline fails at the deadline field', () => {
  const policy = { timeZone: 'UTC', hours: { ...hours, 1: [{ start: '09:00', end: '17:00' }] }, holidays: [] };
  const report = validateSchedule({ jobs: [job('private', '2026-01-05T10:00:00Z', '2026-01-05T11:00:00Z', { deadlineUtc: '2026-01-05T10:30:00Z' })] }, policy);
  assert.equal(report.status, 'fail'); assert.deepEqual(report.findings.map(x => x.ruleId), ['deadline-missed']);
  assert.equal(report.findings[0].location.pointer, '/jobs/0/deadlineUtc');
});
test('missing upstream dependency is incomplete and no late-dependency claim is made', () => {
  const policy = { timeZone: 'UTC', hours: { ...hours, 1: [{ start: '09:00', end: '17:00' }] }, holidays: [] };
  const report = validateSchedule({ jobs: [job('downstream', '2026-01-05T10:00:00Z', '2026-01-05T11:00:00Z', { dependsOn: ['missing'] })] }, policy);
  assert.equal(report.status, 'incomplete'); assert.deepEqual(report.findings.map(x => x.ruleId), ['dependency-unknown']);
});
test('time bound accepts 5000 ms and rejects 5001 ms', () => {
  const policy = { timeZone: 'UTC', hours: { ...hours, 1: [{ start: '09:00', end: '17:00' }] }, holidays: [] };
  const input = { jobs: [job('a', '2026-01-05T10:00:00Z', '2026-01-05T10:01:00Z')] };
  const clock = limit => { let first = true; return () => { if (first) { first = false; return 0; } return limit; }; };
  assert.equal(validateSchedule(input, policy, { now: clock(5000) }).status, 'pass');
  const over = validateSchedule(input, policy, { now: clock(5001) });
  assert.equal(over.status, 'incomplete'); assert.equal(over.findings[0].ruleId, 'time-limit');
});
test('per-job duration bound accepts 10080 minutes and rejects 10081', () => {
  const full = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [i, [{ start: '00:00', end: '12:00' }, { start: '12:00', end: '00:00' }]]));
  const policy = { timeZone: 'UTC', hours: full, holidays: [] };
  const at = validateSchedule({ jobs: [job('a', '2026-01-05T00:00:00Z', '2026-01-12T00:00:00Z')] }, policy, { now: () => 0 });
  assert.equal(at.status, 'pass');
  const over = validateSchedule({ jobs: [job('a', '2026-01-05T00:00:00Z', '2026-01-12T00:01:00Z')] }, policy, { now: () => 0 });
  assert.equal(over.status, 'incomplete'); assert.equal(over.findings[0].ruleId, 'duration-limit');
});
test('total expansion bound accepts 100000 minutes and rejects 100001', () => {
  const full = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [i, [{ start: '00:00', end: '12:00' }, { start: '12:00', end: '00:00' }]]));
  const policy = { timeZone: 'UTC', hours: full, holidays: [] };
  const jobs = Array.from({ length: 10 }, (_, i) => job(String(i), '2026-01-05T00:00:00Z', '2026-01-11T22:40:00Z'));
  const at = validateSchedule({ jobs }, policy, { now: () => 0 });
  assert.equal(at.status, 'pass'); assert.equal(at.summary.checked, 10);
  jobs[9].endUtc = '2026-01-11T22:41:00Z';
  const over = validateSchedule({ jobs }, policy, { now: () => 0 });
  assert.equal(over.status, 'incomplete'); assert.equal(over.findings[0].ruleId, 'expansion-limit');
});
test('holiday list accepts 366 dates and refuses 367', () => {
  const dates = Array.from({ length: 367 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10));
  const policy = { timeZone: 'UTC', hours, holidays: dates.slice(0, 366) };
  assert.equal(validateSchedule({ jobs: [] }, policy).status, 'incomplete');
  policy.holidays = dates;
  assert.throws(() => validateSchedule({ jobs: [] }, policy), ConfigError);
});
test('weekday accepts eight windows and refuses nine', () => {
  const policy = { timeZone: 'UTC', hours: { ...hours, 1: Array.from({ length: 8 }, () => ({ start: '09:00', end: '17:00' })) }, holidays: [] };
  assert.equal(validateSchedule({ jobs: [] }, policy).status, 'incomplete');
  policy.hours[1].push({ start: '09:00', end: '17:00' });
  assert.throws(() => validateSchedule({ jobs: [] }, policy), ConfigError);
});
test('job accepts 1000 dependency references and refuses 1001', () => {
  const policy = { timeZone: 'UTC', hours: { ...hours, 1: [{ start: '09:00', end: '17:00' }] }, holidays: [] };
  const j = job('a', '2026-01-05T10:00:00Z', '2026-01-05T10:01:00Z', { dependsOn: Array.from({ length: 1000 }, () => 'missing') });
  const at = validateSchedule({ jobs: [j] }, policy);
  assert.equal(at.status, 'incomplete'); assert.equal(at.findings[0].ruleId, 'dependency-unknown');
  j.dependsOn.push('missing');
  const over = validateSchedule({ jobs: [j] }, policy);
  assert.equal(over.status, 'incomplete'); assert.equal(over.findings[0].ruleId, 'job-invalid');
});
