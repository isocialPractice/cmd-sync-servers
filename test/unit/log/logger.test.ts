import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createLogger, memorySink, REDACTED, Redactor, runLogSink } from '../../../src/log/logger.ts';
import { tempDir } from '../../helpers/cli.ts';

let temp: ReturnType<typeof tempDir>;

beforeEach(() => {
  temp = tempDir();
});

afterEach(() => {
  temp.cleanup();
});

test('registered secrets are removed from messages and fields', () => {
  const redactor = new Redactor();
  redactor.addSecret('correct horse');
  const sink = memorySink();
  const logger = createLogger({ sinks: [sink], redactor });
  logger.info('login with correct horse failed', { detail: 'tried correct horse twice', nested: { list: ['correct horse'] } });
  const [record] = sink.records;
  assert.equal(record?.message, `login with ${REDACTED} failed`);
  assert.deepEqual(record.fields, { detail: `tried ${REDACTED} twice`, nested: { list: [REDACTED] } });
});

test('a longer secret that contains a shorter one is removed whole', () => {
  const redactor = new Redactor();
  redactor.addSecret('abc');
  redactor.addSecret('abcdef');
  assert.equal(redactor.redact('x abcdef y abc'), `x ${REDACTED} y ${REDACTED}`);
});

test('FTP PASS commands, URL passwords and password query parameters are removed', () => {
  const redactor = new Redactor();
  assert.equal(redactor.redact('> PASS hunter2'), `> PASS ${REDACTED}`);
  assert.equal(redactor.redact('ftp://demo-user:hunter2@ftp.example.com/'), `ftp://demo-user:${REDACTED}@ftp.example.com/`);
  assert.equal(redactor.redact('https://example.com/?user=a&password=hunter2&x=1'), `https://example.com/?user=a&password=${REDACTED}&x=1`);
});

test('string fields with secret-like names are always removed', () => {
  const redactor = new Redactor();
  assert.deepEqual(redactor.redactValue({ password: 'x', passphrase: 'y', apiToken: 'z', savePassword: true, user: 'demo-user' }), {
    password: REDACTED,
    passphrase: REDACTED,
    apiToken: REDACTED,
    savePassword: true,
    user: 'demo-user',
  });
});

test('errors in fields keep their name and code, with the message scrubbed', () => {
  const redactor = new Redactor();
  redactor.addSecret('hunter2');
  const error = Object.assign(new Error('bad password hunter2'), { code: 'E_AUTH' });
  assert.deepEqual(redactor.redactValue({ error }), { error: { name: 'Error', message: `bad password ${REDACTED}`, code: 'E_AUTH' } });
});

test('records below the level are dropped', () => {
  const sink = memorySink();
  const logger = createLogger({ level: 'warn', sinks: [sink] });
  logger.debug('detail');
  logger.info('note');
  logger.warn('careful');
  logger.error('broken');
  assert.deepEqual(
    sink.records.map((record) => record.level),
    ['warn', 'error'],
  );
});

test('the run log is JSON Lines, created on the first record, and keeps the newest 30 runs', () => {
  const logDir = path.join(temp.dir, 'logs');
  const sink = runLogSink(logDir, { now: new Date('2026-10-29T12:00:00Z') });
  const logger = createLogger({ sinks: [sink] });
  assert.equal(readdirSync(temp.dir).includes('logs'), false);
  logger.info('first');
  logger.info('second');
  logger.close();
  const lines = readFileSync(sink.file, 'utf8').trim().split('\n');
  assert.deepEqual(
    lines.map((line) => (JSON.parse(line) as { message: string }).message),
    ['first', 'second'],
  );
  if (process.platform !== 'win32') {
    assert.equal(statSync(sink.file).mode & 0o777, 0o600);
  }

  for (let index = 0; index < 35; index += 1) {
    writeFileSync(path.join(logDir, `run-20260101-0000${String(index).padStart(2, '0')}-1.jsonl`), '');
  }
  const next = runLogSink(logDir, { now: new Date('2026-10-30T12:00:00Z') });
  next.write({ time: '', level: 'info', message: 'third' });
  next.close?.();
  const runs = readdirSync(logDir).filter((name) => name.startsWith('run-'));
  assert.equal(runs.length, 30);
  assert.ok(runs.includes(path.basename(next.file)));
  assert.ok(runs.includes(path.basename(sink.file)));
});
