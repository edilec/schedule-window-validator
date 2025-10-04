export const TOOL_ID = 'schedule-window-validator';

export const LIMITS = Object.freeze({ bytes: 1_048_576, jobs: 1000, depth: 16, minutesPerJob: 10080, totalMinutes: 100000, milliseconds: 5000 });
export const RULE_SEVERITY = Object.freeze({ 'input-unreadable': 'error', 'input-invalid': 'error', 'job-invalid': 'error', 'job-duplicate': 'error', 'dependency-unknown': 'error', 'byte-limit': 'error', 'record-limit': 'error', 'depth-limit': 'error', 'duration-limit': 'error', 'expansion-limit': 'error', 'time-limit': 'error', 'outside-hours': 'error', 'holiday-blocked': 'error', 'deadline-missed': 'error', 'dependency-late': 'error' });
const INCOMPLETE = new Set(['input-unreadable', 'input-invalid', 'job-invalid', 'job-duplicate', 'dependency-unknown', 'byte-limit', 'record-limit', 'depth-limit', 'duration-limit', 'expansion-limit', 'time-limit']);
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const usable = x => typeof x === 'string' && x.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\p{Cf}]/gu, '').trim().length > 0 && x.length <= 256;
const date = x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && !Number.isNaN(Date.parse(`${x}T00:00:00Z`)) && new Date(`${x}T00:00:00Z`).toISOString().slice(0, 10) === x;
const instant = x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/.test(x) && !Number.isNaN(Date.parse(x)) && new Date(x).toISOString().replace('.000Z', 'Z') === x;
const hm = x => typeof x === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(x);
const minute = x => Number(x.slice(0, 2)) * 60 + Number(x.slice(3));
function depthExceeded(x, depth = 0) { if (depth > LIMITS.depth) return true; return x && typeof x === 'object' && Object.values(x).some(v => depthExceeded(v, depth + 1)); }

export class ConfigError extends Error {}
function policyOf(raw) {
  if (!record(raw) || typeof raw.timeZone !== 'string' || !record(raw.hours) || !Array.isArray(raw.holidays)) throw new ConfigError('Invalid policy');
  if (Object.keys(raw).some(k => !['timeZone', 'hours', 'holidays'].includes(k))) throw new ConfigError('Unknown policy key');
  let formatter;
  try { formatter = new Intl.DateTimeFormat('en-US', { timeZone: raw.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
  catch { throw new ConfigError('Invalid time zone'); }
  if (Object.keys(raw.hours).length !== 7 || raw.holidays.length > 366 || raw.holidays.some(x => !date(x)) || new Set(raw.holidays).size !== raw.holidays.length) throw new ConfigError('Invalid operating hours or holidays');
  const hours = [];
  for (let day = 0; day < 7; day++) {
    const windows = raw.hours[String(day)];
    if (!Array.isArray(windows) || windows.length > 8 || windows.some(w => !record(w) || Object.keys(w).some(k => !['start', 'end'].includes(k)) || !hm(w.start) || !hm(w.end) || w.start === w.end)) throw new ConfigError('Invalid operating window');
    hours.push(windows.map(w => ({ start: minute(w.start), end: minute(w.end) })));
  }
  return { formatter, hours, holidays: new Set(raw.holidays) };
}
function add(findings, ruleId, pointer, message) {
  if (!Object.hasOwn(RULE_SEVERITY, ruleId)) throw new Error('Unknown rule');
  findings.push({ ruleId, severity: RULE_SEVERITY[ruleId], message, location: { file: '@schedule', pointer } });
}
function report(findings, checked) {
  findings.sort((a, b) => cmp(a.location.file, b.location.file) || cmp(a.location.pointer, b.location.pointer) || cmp(a.ruleId, b.ruleId));
  const status = findings.some(f => INCOMPLETE.has(f.ruleId)) ? 'incomplete' : findings.some(f => f.severity === 'error') ? 'fail' : 'pass';
  return { schemaVersion: '1', tool: TOOL_ID, status, summary: { checked, errors: findings.filter(f => f.severity === 'error').length, warnings: 0 }, findings };
}
export function incomplete(ruleId, message) { const findings = []; add(findings, ruleId, '', message); return report(findings, 0); }
function localAt(ms, formatter) {
  const parts = Object.fromEntries(formatter.formatToParts(ms).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  return { day, weekday: new Date(`${day}T00:00:00Z`).getUTCDay(), minute: Number(parts.hour) * 60 + Number(parts.minute) };
}
function allowed(local, hours) {
  const current = hours[local.weekday].some(w => w.end > w.start ? local.minute >= w.start && local.minute < w.end : local.minute >= w.start);
  const previous = hours[(local.weekday + 6) % 7].some(w => w.end < w.start && local.minute < w.end);
  return current || previous;
}
export function validateSchedule(input, rawPolicy, { now = () => performance.now() } = {}) {
  const started = now();
  const policy = policyOf(rawPolicy), findings = [];
  if (!record(input) || !Array.isArray(input.jobs) || input.jobs.length === 0) return incomplete('input-invalid', 'A nonempty jobs array is required.');
  if (depthExceeded(input)) return incomplete('depth-limit', 'Schedule exceeds nesting depth 16.');
  if (input.jobs.length > LIMITS.jobs) return incomplete('record-limit', 'Schedule exceeds 1000 jobs.');
  const jobs = new Map(), ambiguous = new Set(); let totalMinutes = 0;
  for (const [i, j] of input.jobs.entries()) {
    if (now() - started > LIMITS.milliseconds) return incomplete('time-limit', 'Evaluation exceeded 5000 milliseconds.');
    if (!record(j) || !usable(j.id) || !instant(j.startUtc) || !instant(j.endUtc) || !Array.isArray(j.dependsOn) || j.dependsOn.length > LIMITS.jobs || j.dependsOn.some(x => !usable(x)) || (j.deadlineUtc !== undefined && !instant(j.deadlineUtc)) || (instant(j.startUtc) && instant(j.endUtc) && j.endUtc <= j.startUtc)) {
      if (record(j) && usable(j.id)) ambiguous.add(j.id);
      add(findings, 'job-invalid', `/jobs/${i}`, 'Job has invalid identity, timestamps, or dependencies.'); continue;
    }
    if (jobs.has(j.id)) { ambiguous.add(j.id); add(findings, 'job-duplicate', `/jobs/${i}`, 'Job identity is duplicated.'); }
    else jobs.set(j.id, { ...j, ordinal: i, startMs: Date.parse(j.startUtc), endMs: Date.parse(j.endUtc) });
    const duration = (Date.parse(j.endUtc) - Date.parse(j.startUtc)) / 60000;
    if (duration > LIMITS.minutesPerJob) add(findings, 'duration-limit', `/jobs/${i}`, 'Job exceeds 10080 minutes.');
    totalMinutes += duration;
  }
  if (findings.some(f => INCOMPLETE.has(f.ruleId))) return report(findings, 0);
  if (totalMinutes > LIMITS.totalMinutes) return incomplete('expansion-limit', 'Schedule exceeds 100000 expanded minutes.');
  for (const j of jobs.values()) {
    for (const [k, depId] of j.dependsOn.entries()) {
      const dep = jobs.get(depId);
      if (!dep || ambiguous.has(depId)) add(findings, 'dependency-unknown', `/jobs/${j.ordinal}/dependsOn/${k}`, 'Required dependency is absent or ambiguous.');
      else if (dep.endMs > j.startMs) add(findings, 'dependency-late', `/jobs/${j.ordinal}/dependsOn/${k}`, 'Required dependency finishes after this job starts.');
    }
    if (j.deadlineUtc !== undefined && j.endMs > Date.parse(j.deadlineUtc)) add(findings, 'deadline-missed', `/jobs/${j.ordinal}/deadlineUtc`, 'Job ends after its deadline.');
    let holiday = false, outside = false;
    for (let ms = j.startMs; ms < j.endMs; ms += 60000) {
      if (now() - started > LIMITS.milliseconds) return incomplete('time-limit', 'Evaluation exceeded 5000 milliseconds.');
      const local = localAt(ms, policy.formatter);
      if (policy.holidays.has(local.day)) holiday = true;
      else if (!allowed(local, policy.hours)) outside = true;
      if (holiday && outside) break;
    }
    if (holiday) add(findings, 'holiday-blocked', `/jobs/${j.ordinal}`, 'Job intersects a local holiday.');
    if (outside) add(findings, 'outside-hours', `/jobs/${j.ordinal}`, 'Job extends outside operating hours.');
  }
  return report(findings, jobs.size);
}
