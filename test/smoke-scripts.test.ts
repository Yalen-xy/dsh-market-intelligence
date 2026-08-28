import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runLiveSmoke } from '../scripts/live-smoke.mjs';
import { runProfileSmoke } from '../scripts/profile-smoke.mjs';

const LIVE_FIELDS = ['byteCount', 'capability', 'marketTimestamp', 'provider', 'status'];

test('live smoke accepts capability-appropriate content types and emits only five safe fields', async () => {
  const lines: string[] = [];
  const exitCode = await runLiveSmoke({
    fetchImpl: successfulLiveFetch(),
    write: (line: string) => lines.push(line),
  });

  assert.equal(exitCode, 0);
  assert.equal(lines.length, 7);
  const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  for (const record of records) {
    assert.deepEqual(Object.keys(record).sort(), LIVE_FIELDS);
    assert.equal(record.status, 'ok');
    assert.equal(typeof record.byteCount, 'number');
    assert.equal((record.byteCount as number) > 0, true);
  }
  assert.deepEqual(
    records.find(({ capability }) => capability === 'search'),
    { provider: 'tencent', capability: 'search', status: 'ok', byteCount: 21, marketTimestamp: null },
  );
});

for (const [expected, dailyResponse] of [
  ['network', () => Promise.reject(new Error('private network detail'))],
  ['http', () => Promise.resolve(new Response('unavailable', { status: 503, headers: { 'content-type': 'application/json' } }))],
  ['content-type', () => Promise.resolve(new Response('{}', { headers: { 'content-type': 'image/png' } }))],
  ['parse', () => Promise.resolve(new Response('{', { headers: { 'content-type': 'application/json' } }))],
  ['empty', () => Promise.resolve(new Response('{"data":{}}', { headers: { 'content-type': 'application/json' } }))],
] as const) {
  test(`live smoke classifies ${expected} failures without exposing response details`, async () => {
    const lines: string[] = [];
    const fallback = successfulLiveFetch();
    const exitCode = await runLiveSmoke({
      fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === '/appstock/app/fqkline/get') return dailyResponse();
        return fallback(input, init);
      },
      write: (line: string) => lines.push(line),
    });

    assert.equal(exitCode, 1);
    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const daily = records.find(({ capability }) => capability === 'daily');
    assert.equal(daily?.status, expected);
    assert.deepEqual(Object.keys(daily ?? {}).sort(), LIVE_FIELDS);
    assert.equal(JSON.stringify(records).includes('private network detail'), false);
    assert.equal(JSON.stringify(records).includes('unavailable'), false);
  });
}

test('live smoke rejects a text capability served with a binary content type', async () => {
  const lines: string[] = [];
  const fallback = successfulLiveFetch();
  const exitCode = await runLiveSmoke({
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin === 'https://smartbox.gtimg.cn') {
        return new Response('hk~00700~Tencent~~GP\n', { headers: { 'content-type': 'application/octet-stream' } });
      }
      return fallback(input, init);
    },
    write: (line: string) => lines.push(line),
  });

  assert.equal(exitCode, 1);
  const search = lines.map((line) => JSON.parse(line)).find(({ capability }) => capability === 'search');
  assert.equal(search.status, 'content-type');
  assert.equal(search.marketTimestamp, null);
});

test('profile smoke restores process state and removes its root when context creation fails', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'dsh-profile-failure-'));
  const root = path.join(parent, 'smoke-root');
  const previousDshHome = process.env.DSH_HOME;
  const previousFetch = globalThis.fetch;
  try {
    await assert.rejects(
      runProfileSmoke({
        cwd: parent,
        mkdtempImpl: async () => {
          await mkdir(root);
          return root;
        },
        createContext: () => {
          throw new Error('injected context failure');
        },
        write: () => undefined,
      }),
      /injected context failure/,
    );
    await assert.rejects(access(root));
    assert.equal(process.env.DSH_HOME, previousDshHome);
    assert.equal(globalThis.fetch, previousFetch);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

function successfulLiveFetch(): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
    if (url.origin === 'https://web.ifzq.gtimg.cn' && url.pathname === '/appstock/app/minute/query') {
      const symbol = url.searchParams.get('code') as string;
      return response(JSON.stringify({
        data: {
          [symbol]: {
            qt: { [symbol]: ['51', symbol, symbol, '10.15', '10.10', '10.00', '125000', '1015000', '10.20', '9.95'] },
            data: { date: '2026-08-27', data: ['0930 10.15 3200'] },
          },
        },
      }), 'text/html; charset=utf-8');
    }
    if (url.origin === 'https://web.ifzq.gtimg.cn' && url.pathname === '/appstock/app/fqkline/get') {
      return response(JSON.stringify({
        data: { sh000001: { qfqday: [['2026-08-27', '10.00', '10.15', '10.20', '9.95', '1000', '10150']] } },
      }), 'text/html; charset=utf-8');
    }
    if (url.origin === 'https://smartbox.gtimg.cn') {
      return response('hk~00700~Tencent~~GP\n', 'text/plain; charset=gbk');
    }
    if (url.toString().startsWith('https://hq.sinajs.cn/list=')) {
      return response('var hq_str_sh600000="Bank,10.00,9.90,10.15,10.20,9.80,0,0,1000,1015000,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2026-08-27,10:00:00,00";', 'application/x-javascript; charset=gbk');
    }
    if (url.pathname.endsWith('/newSinaHy.php')) {
      return response('var S_Finance_bankuai_sinaindustry={"bank":"Banking,2.10,100,200000000,sh600000,Bank,3.20"};', 'text/javascript; charset=gbk');
    }
    if (url.pathname.endsWith('/newFLJK.php')) {
      return response('var S_Finance_bankuai_sinaindustry={"ai":"AI,1.25,100,123456789,sz000001,Bank,-0.50"};', 'text/plain; charset=gbk');
    }
    throw new Error('unexpected fake URL');
  };
}

function response(body: string, contentType: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}
