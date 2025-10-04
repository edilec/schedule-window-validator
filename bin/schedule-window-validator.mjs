#!/usr/bin/env node
import { readFile, realpath, stat, lstat, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve, relative, dirname, basename, isAbsolute, sep, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateSchedule, incomplete, ConfigError, LIMITS } from '../src/index.mjs';

const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === '--help') {
  process.stdout.write('Usage: schedule-window-validator --root DIR --schedule FILE --policy FILE [--out FILE] [--human]\nJSON report goes to stdout; --out also writes it within root.\n');
} else {
  let root, schedule, policy, out, human = false;
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--human') { if (human) throw new ConfigError('Repeated option'); human = true; continue; }
      if (!['--root', '--schedule', '--policy', '--out'].includes(a) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new ConfigError('Invalid option');
      const value = argv[++i];
      if (a === '--root') { if (root) throw new ConfigError('Repeated root'); root = value; }
      if (a === '--schedule') { if (schedule) throw new ConfigError('Repeated schedule'); schedule = value; }
      if (a === '--policy') { if (policy) throw new ConfigError('Repeated policy'); policy = value; }
      if (a === '--out') { if (out) throw new ConfigError('Repeated output'); out = value; }
    }
    if (!root || !schedule || !policy || isAbsolute(schedule) || isAbsolute(policy) || (out && isAbsolute(out))) throw new ConfigError('Root and relative evidence paths required');
    root = await realpath(root);
    if (!(await stat(root)).isDirectory()) throw new ConfigError('Root is not a directory');
  } catch { process.stderr.write('Invalid configuration. Use --help.\n'); process.exit(2); }
  const inside = path => { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
  async function readDocument(name) {
    const file = await realpath(resolve(root, name));
    if (!inside(file)) throw new Error('input-unreadable');
    const meta = await stat(file);
    if (!meta.isFile()) throw new Error('input-unreadable');
    if (meta.size > LIMITS.bytes) throw new Error('byte-limit');
    const bytes = await readFile(file, { signal: AbortSignal.timeout(LIMITS.milliseconds) });
    if (bytes.length > LIMITS.bytes) throw new Error('byte-limit');
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const stack = [[value, 0]];
    while (stack.length) {
      const [node, depth] = stack.pop();
      if (depth > LIMITS.depth) throw new Error('depth-limit');
      if (node && typeof node === 'object') for (const child of Object.values(node)) stack.push([child, depth + 1]);
    }
    return { value, file };
  }
  let policyDoc;
  try {
    policyDoc = await readDocument(policy);
    validateSchedule({ jobs: [] }, policyDoc.value);
  } catch { process.stderr.write('Policy cannot be read or is invalid.\n'); process.exit(2); }
  let scheduleDoc, result;
  try { scheduleDoc = await readDocument(schedule); result = validateSchedule(scheduleDoc.value, policyDoc.value); }
  catch (error) {
    const rule = error.message === 'byte-limit' || error.message === 'depth-limit' ? error.message : 'input-unreadable';
    const messages = { 'byte-limit': 'Schedule exceeds 1048576 bytes.', 'depth-limit': 'Schedule exceeds nesting depth 16.', 'input-unreadable': 'Schedule could not be read, decoded, or parsed within the declared root.' };
    result = incomplete(rule, messages[rule]);
  }
  const rendered = `${JSON.stringify(result, null, 2)}\n`;
  if (out) {
    try {
      const destination = resolve(root, out), parent = await realpath(dirname(destination));
      if (!inside(parent) || !inside(destination)) throw new Error('outside root');
      const actualDestination = join(parent, basename(destination));
      for (const name of [schedule, policy]) {
        if (destination === resolve(root, name)) throw new Error('output aliases named input');
        const namedInput = await realpath(dirname(resolve(root, name))).then(p => join(p, basename(resolve(root, name)))).catch(() => null);
        if (actualDestination === namedInput) throw new Error('output aliases named input');
      }
      let old;
      try { old = await lstat(destination); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (old?.isSymbolicLink() || old?.isDirectory()) throw new Error('invalid output');
      if (old) for (const file of [policyDoc.file, scheduleDoc?.file].filter(Boolean)) {
        const source = await stat(file);
        if (old.dev === source.dev && old.ino === source.ino) throw new Error('output aliases input');
      }
      const temp = join(parent, `.${basename(destination)}.${randomUUID()}.tmp`);
      try { await writeFile(temp, rendered, { flag: 'wx', mode: 0o600 }); await rename(temp, destination); }
      catch (e) { await unlink(temp).catch(() => {}); throw e; }
    } catch { process.stderr.write('Output destination refused or write failed.\n'); process.exit(2); }
  }
  process.stdout.write(rendered);
  if (human) process.stderr.write(`Schedule: ${result.status}; ${result.summary.checked} jobs evaluated; ${result.summary.errors} findings.\n`);
  process.exitCode = result.status === 'pass' ? 0 : result.status === 'fail' ? 1 : 2;
}
