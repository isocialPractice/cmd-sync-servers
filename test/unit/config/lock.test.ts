import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, test } from 'node:test';
import { withFileLock } from '../../../src/config/lock.ts';
import { tempDir } from '../../helpers/cli.ts';

let temp: ReturnType<typeof tempDir>;
let lock: string;

beforeEach(() => {
  temp = tempDir();
  lock = path.join(temp.dir, 'sites.json.lock');
});

afterEach(() => {
  temp.cleanup();
});

function staleLock(): void {
  writeFileSync(lock, JSON.stringify({ pid: 1, host: 'other-host', createdAt: '2026-01-01T00:00:00Z', token: 'stale-token' }));
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
}

test('waiters that find the same stale lock never hold it at once', async () => {
  staleLock();
  let inside = 0;
  let most = 0;
  const task = async (): Promise<void> => {
    inside += 1;
    most = Math.max(most, inside);
    await delay(20);
    inside -= 1;
  };
  await Promise.all(Array.from({ length: 6 }, () => withFileLock(lock, task, { timeoutMs: 5000 })));
  assert.equal(most, 1);
  assert.ok(!existsSync(lock));
  assert.deepEqual(readdirSync(temp.dir), []);
});

test('a holder removes only its own lock', async () => {
  await withFileLock(lock, () => {
    // Another process took the lock over meanwhile, as after a very long pause.
    writeFileSync(lock, JSON.stringify({ pid: 2, host: 'other-host', createdAt: new Date().toISOString(), token: 'someone-else' }));
    return Promise.resolve();
  });
  assert.match(readFileSync(lock, 'utf8'), /someone-else/);
});

test('a lock left by a process that is gone is taken over at once', async () => {
  writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, host: (await import('node:os')).hostname(), createdAt: new Date().toISOString(), token: 'gone' }));
  let ran = false;
  await withFileLock(lock, () => {
    ran = true;
    return Promise.resolve();
  }, { timeoutMs: 200 });
  assert.ok(ran);
});
