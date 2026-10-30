import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SyncError } from '../../../src/errors.ts';
import { ROOT } from '../../../src/sync/paths.ts';
import { TransportPool } from '../../../src/transport/pool.ts';
import { isTransient, withRetry } from '../../../src/transport/retry.ts';
import type { Capabilities, Transport } from '../../../src/transport/types.ts';

const transient = (code = 'E_CONNECTION' as const, serverCode?: number): SyncError =>
  new SyncError(code, 'reset', { transient: true, ...(serverCode === undefined ? {} : { serverCode }) });

test('isTransient is true only for transient SyncErrors', () => {
  assert.equal(isTransient(transient()), true);
  assert.equal(isTransient(new SyncError('E_REMOTE', 'no')), false);
  assert.equal(isTransient(new Error('plain')), false);
});

test('withRetry retries transient failures with the given delays, then succeeds', async () => {
  const seen: number[] = [];
  const result = await withRetry(
    (attempt) => {
      seen.push(attempt);
      return attempt < 2 ? Promise.reject(transient()) : Promise.resolve('done');
    },
    { delaysMs: [1, 1, 1], onRetry: (_error, retry, delay) => seen.push(100 + retry * 10 + delay) },
  );
  assert.equal(result, 'done');
  assert.deepEqual(seen, [0, 111, 1, 121, 2]);
});

test('withRetry gives up after the last delay, and never retries a permanent failure', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(() => {
      calls += 1;
      return Promise.reject(transient());
    }, { delaysMs: [1, 1] }),
    (error) => isTransient(error),
  );
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(
    withRetry(() => {
      calls += 1;
      return Promise.reject(new SyncError('E_REMOTE', 'permission denied', { serverCode: 550 }));
    }, { delaysMs: [1, 1] }),
  );
  assert.equal(calls, 1);
});

test('withRetry stops waiting when cancelled', async () => {
  const controller = new AbortController();
  const pending = withRetry(() => Promise.reject(transient()), { delaysMs: [60_000], signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => isTransient(error));
});

class FakeTransport implements Transport {
  static opened = 0;
  static closed = 0;
  readonly id: number;
  failConnect: SyncError | undefined;
  constructor(failConnect?: SyncError) {
    FakeTransport.opened += 1;
    this.id = FakeTransport.opened;
    this.failConnect = failConnect;
  }
  connect(): Promise<Capabilities> {
    return this.failConnect === undefined
      ? Promise.resolve({
          protocol: 'ftps',
          mtimePrecisionMs: 1000,
          canSetMtime: true,
          canChmod: true,
          atomicReplace: false,
          software: undefined,
          tls: undefined,
          hostKey: undefined,
          features: [],
        })
      : Promise.reject(this.failConnect);
  }
  list = () => Promise.resolve([]);
  stat = () => Promise.resolve(undefined);
  get = () => Promise.resolve();
  put = () => Promise.resolve();
  rename = () => Promise.resolve();
  remove = () => Promise.resolve();
  mkdir = () => Promise.resolve();
  close(): Promise<void> {
    FakeTransport.closed += 1;
    return Promise.resolve();
  }
}

test('an FTP-style pool reuses an idle connection and replaces a broken one', async () => {
  FakeTransport.opened = 0;
  FakeTransport.closed = 0;
  const pool = new TransportPool(() => new FakeTransport(), { size: 2, shared: false });
  const first = await pool.run((transport) => Promise.resolve((transport as FakeTransport).id));
  const second = await pool.run((transport) => Promise.resolve((transport as FakeTransport).id));
  assert.equal(first, second);
  await assert.rejects(pool.run(() => Promise.reject(transient())));
  const third = await pool.run((transport) => Promise.resolve((transport as FakeTransport).id));
  assert.notEqual(third, first);
  assert.equal(FakeTransport.closed, 1);
  await pool.close();
  assert.equal(FakeTransport.closed, 2);
});

test('the pool never runs more than its size at once', async () => {
  let running = 0;
  let peak = 0;
  const pool = new TransportPool(() => new FakeTransport(), { size: 2, shared: false });
  await Promise.all(
    Array.from({ length: 6 }, () =>
      pool.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
      }),
    ),
  );
  assert.equal(peak, 2);
  await pool.close();
});

test('a shared pool uses one connection for every operation', async () => {
  FakeTransport.opened = 0;
  const pool = new TransportPool(() => new FakeTransport(), { size: 4, shared: true });
  const ids = await Promise.all(Array.from({ length: 4 }, () => pool.run((transport) => Promise.resolve((transport as FakeTransport).id))));
  assert.deepEqual(new Set(ids), new Set([1]));
  await pool.close();
});

test('a 421 shrinks the pool; a connection that never opened is never reused', async () => {
  let fail = true;
  const pool = new TransportPool(() => new FakeTransport(fail ? transient('E_CONNECTION', 421) : undefined), { size: 3, shared: false });
  await assert.rejects(pool.run((transport) => transport.list(ROOT)));
  assert.equal(pool.limit, 2);
  fail = false;
  assert.deepEqual(await pool.run((transport) => transport.list(ROOT)), []);
  await pool.close();
});
