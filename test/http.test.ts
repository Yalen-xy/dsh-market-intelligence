import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixedGet } from '../src/http.ts';
import { TENCENT_MINUTE_URL } from '../src/providers/tencent.ts';

test('rejects an unapproved host and cross-host redirect', async () => {
  await assert.rejects(
    () => fixedGet({ url: new URL('https://example.com/x'), timeoutMs: 1_000, maxBytes: 1_024 }, fetch, AbortSignal.timeout(2_000)),
    /host not allowed/i,
  );
  await assert.rejects(
    () => fixedGet({ url: new URL('https://web.ifzq.gtimg.cn:8443/appstock/app/minute/query?code=sh600000'), timeoutMs: 1_000, maxBytes: 1_024 }, fetch, AbortSignal.timeout(2_000)),
    /host not allowed/i,
  );

  const redirecting = async () => new Response('', {
    status: 302,
    headers: { location: 'https://example.com/x' },
  });
  await assert.rejects(
    () => fixedGet({ url: new URL(TENCENT_MINUTE_URL.replace('{code}', 'sh600000')), timeoutMs: 1_000, maxBytes: 1_024 }, redirecting as typeof fetch, AbortSignal.timeout(2_000)),
    /redirect/i,
  );
});

test('rejects sibling routes and credential-bearing URLs', async () => {
  const response = async () => new Response('ok', { headers: { 'content-length': '2' } });
  const hostileUrls = [
    'https://web.ifzq.gtimg.cn/appstock/app/minute/query-evil?code=sh600000',
    'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get-evil?param=sh600000,day',
    'https://smartbox.gtimg.cn/s3-evil/?q=test',
    'https://hq.sinajs.cn/list-evil=sh600000',
    'https://money.finance.sina.com.cn/q/view-evil/',
    'https://vip.stock.finance.sina.com.cn/q/view-evil/',
  ];
  for (const url of hostileUrls) {
    await assert.rejects(
      () => fixedGet({ url: new URL(url), timeoutMs: 1_000, maxBytes: 1_024 }, response as typeof fetch, AbortSignal.timeout(2_000)),
      /host not allowed/i,
    );
  }
  await assert.rejects(
    () => fixedGet({ url: new URL('https://user:pass@web.ifzq.gtimg.cn/appstock/app/minute/query?code=sh600000'), timeoutMs: 1_000, maxBytes: 1_024 }, response as typeof fetch, AbortSignal.timeout(2_000)),
    /host not allowed/i,
  );
});

test('omits credentials from allowed fetches', async () => {
  let init: RequestInit | undefined;
  const response = async (_input: RequestInfo | URL, options?: RequestInit) => {
    init = options;
    return new Response('ok', { headers: { 'content-length': '2' } });
  };
  await fixedGet({ url: new URL(TENCENT_MINUTE_URL.replace('{code}', 'sh600000')), timeoutMs: 1_000, maxBytes: 1_024 }, response as typeof fetch, AbortSignal.timeout(2_000));
  assert.equal(init?.credentials, 'omit');
});

test('allows the reviewed parameterized Sina list route', async () => {
  const response = async () => new Response('ok', { headers: { 'content-length': '2' } });
  assert.deepEqual(
    await fixedGet({ url: new URL('https://hq.sinajs.cn/list=sh600000'), timeoutMs: 1_000, maxBytes: 1_024 }, response as typeof fetch, AbortSignal.timeout(2_000)),
    new Uint8Array([111, 107]),
  );
});

test('allows only the reviewed Sina sector endpoints', async () => {
  const response = async () => new Response('ok', { headers: { 'content-length': '2' } });
  const allowed = [
    'https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php',
    'https://money.finance.sina.com.cn/q/view/newFLJK.php?param=class',
  ];
  const rejected = [
    'https://vip.stock.finance.sina.com.cn/q/view/hostile.php',
    'https://money.finance.sina.com.cn/q/view/newFLJK.php?param=other',
    'https://vip.stock.finance.sina.com.cn/q/view/newFLJK.php?param=class',
    'https://money.finance.sina.com.cn/q/view/newSinaHy.php',
  ];
  for (const url of allowed) {
    assert.deepEqual(
      await fixedGet({ url: new URL(url), timeoutMs: 1_000, maxBytes: 1_024 }, response as typeof fetch, AbortSignal.timeout(2_000)),
      new Uint8Array([111, 107]),
    );
  }
  for (const url of rejected) {
    await assert.rejects(
      () => fixedGet({ url: new URL(url), timeoutMs: 1_000, maxBytes: 1_024 }, response as typeof fetch, AbortSignal.timeout(2_000)),
      /host not allowed/i,
    );
  }
});

test('accepts chunked responses but enforces declared and streamed byte limits', async () => {
  const url = new URL(TENCENT_MINUTE_URL.replace('{code}', 'sh600000'));
  const chunked = async () => new Response(new Uint8Array([1, 2, 3]));
  assert.deepEqual(await fixedGet({ url, timeoutMs: 1_000, maxBytes: 3 }, chunked as typeof fetch, AbortSignal.timeout(2_000)), new Uint8Array([1, 2, 3]));

  const declaredOversize = async () => new Response(new Uint8Array([1]), { headers: { 'content-length': '4' } });
  await assert.rejects(
    () => fixedGet({ url, timeoutMs: 1_000, maxBytes: 3 }, declaredOversize as typeof fetch, AbortSignal.timeout(2_000)),
    /response too large/i,
  );

  const streamOversize = async () => new Response(new Uint8Array([1, 2, 3, 4]));
  await assert.rejects(
    () => fixedGet({ url, timeoutMs: 1_000, maxBytes: 3 }, streamOversize as typeof fetch, AbortSignal.timeout(2_000)),
    /response too large/i,
  );
});

test('rejects a verifiably mismatched declared content length without leaking a response body', async () => {
  const url = new URL(TENCENT_MINUTE_URL.replace('{code}', 'sh600000'));
  const mismatched = async () => new Response('private response text', { headers: { 'content-length': '1' } });
  await assert.rejects(
    () => fixedGet({ url, timeoutMs: 1_000, maxBytes: 100 }, mismatched as typeof fetch, AbortSignal.timeout(2_000)),
    (error: unknown) => error instanceof Error && /content length/i.test(error.message) && !error.message.includes('private response text'),
  );
});

test('accepts a decoded compressed response whose wire content length cannot match', async () => {
  const url = new URL(TENCENT_MINUTE_URL.replace('{code}', 'sh600000'));
  const decoded = new TextEncoder().encode('decompressed');
  const compressed = async () => new Response(decoded, { headers: { 'content-length': '4', 'content-encoding': 'gzip' } });
  assert.deepEqual(
    await fixedGet({ url, timeoutMs: 1_000, maxBytes: 100 }, compressed as typeof fetch, AbortSignal.timeout(2_000)),
    decoded,
  );
});
