import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SinaProvider } from '../src/providers/sina.ts';
import { TencentProvider } from '../src/providers/tencent.ts';

type SharedLimiter = {
  run<T>(signal: AbortSignal, task: (signal: AbortSignal) => Promise<T>): Promise<T>;
  dispose(): Promise<void>;
};

type SharedLimiterConstructor = new (limit: number) => SharedLimiter;

test('one shared limit covers parallel Tencent and Sina physical requests', async () => {
  const limiter = await createLimiter(1);
  let active = 0;
  let peak = 0;
  let requestCount = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const fetchImpl = (async (input: URL | RequestInfo) => {
    requestCount++;
    active++;
    peak = Math.max(peak, active);
    await barrier;
    active--;
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    const body = url.hostname === 'web.ifzq.gtimg.cn'
      ? JSON.stringify({
        data: {
          sh600000: {
            qt: { sh600000: [0, 'Example', 0, '10', '9.9', '9.8', '100', '1000', '10.2', '9.7'] },
            data: { date: '2026-08-27', data: ['1000 10 100'] },
          },
        },
      })
      : 'var sector_fixture={"bank":"Banking,1,0,100,sh600000,Example,2"};';
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  const now = () => Date.parse('2026-08-27T02:00:05.000Z');
  const tencent = new TencentProvider({ fetch: fetchImpl, now, quoteConcurrency: 4, requestLimiter: limiter });
  const sina = new SinaProvider({ fetch: fetchImpl, now, requestLimiter: limiter });

  const requests = Promise.all([
    tencent.quotes(['sh600000'], new AbortController().signal),
    sina.sectors(new AbortController().signal),
  ]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  release();
  await requests;
  await limiter.dispose();

  assert.equal(requestCount, 3);
  assert.equal(peak, 1);
});

test('shared limiter removes cancelled waiters and disposal aborts and drains active work', async () => {
  const limiter = await createLimiter(1);
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  let queuedStarted = false;
  const first = limiter.run(new AbortController().signal, async (signal) => {
    firstStarted();
    return new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const firstRejection = assert.rejects(first, { name: 'AbortError' });
  await started;

  const caller = new AbortController();
  const queued = limiter.run(caller.signal, async () => {
    queuedStarted = true;
  });
  const queuedRejection = assert.rejects(queued, { name: 'AbortError' });
  caller.abort(new DOMException('caller cancelled', 'AbortError'));
  await queuedRejection;
  assert.equal(queuedStarted, false);

  const disposal = limiter.dispose();
  await firstRejection;
  await disposal;
  await assert.rejects(
    limiter.run(new AbortController().signal, async () => undefined),
    { name: 'AbortError' },
  );
});

async function createLimiter(limit: number): Promise<SharedLimiter> {
  const module = await import('../src/http.ts') as typeof import('../src/http.ts') & {
    SharedRequestLimiter?: SharedLimiterConstructor;
  };
  if (typeof module.SharedRequestLimiter !== 'function') {
    assert.fail('SharedRequestLimiter is not implemented');
  }
  return new module.SharedRequestLimiter(limit);
}
