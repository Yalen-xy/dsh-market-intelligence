import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  TencentProvider,
  TENCENT_KLINE_URL,
  TENCENT_MINUTE_URL,
  TENCENT_SMARTBOX_URL,
} from '../lib/providers/tencent.js';
import {
  SinaProvider,
  SINA_CONCEPT_URL,
  SINA_INDUSTRY_URL,
  SINA_QUOTE_URL,
} from '../lib/providers/sina.js';

const FAILURE_CATEGORIES = new Set(['network', 'http', 'content-type', 'parse', 'empty']);

export async function runLiveSmoke({ fetchImpl = globalThis.fetch, write = (line) => process.stdout.write(line) } = {}) {
  const telemetry = [];
  let currentCapability = null;
  const guardedFetch = async (input, init) => {
    const capability = currentCapability;
    const url = new URL(String(input));
    assertReviewedUrl(url);
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'manual');
    assert.equal(init?.credentials, 'omit');
    assert.equal(hasSensitiveHeader(init?.headers), false);
    const request = { capability, bytes: 0, failure: null };
    telemetry.push(request);
    let response;
    try {
      response = await fetchImpl(url, init);
    } catch {
      request.failure = 'network';
      throw new SmokeFailure('network');
    }
    if (!response.ok) {
      request.failure = 'http';
      throw new SmokeFailure('http');
    }
    if (!contentTypeMatches(capability, response.headers.get('content-type'))) {
      request.failure = 'content-type';
      throw new SmokeFailure('content-type');
    }
    const body = response.body?.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        request.bytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
    })) ?? null;
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  const tencent = new TencentProvider({ fetch: guardedFetch, requestTimeoutMs: 8_000, quoteConcurrency: 2 });
  const sina = new SinaProvider({ fetch: guardedFetch, requestTimeoutMs: 8_000 });
  let failed = false;

  const checks = [
    ['tencent', 'quotes', async () => requireItems(await tencent.quotes(['sh000001', 'hkHSI'], new AbortController().signal))],
    ['tencent', 'minute', async () => requireItems(await tencent.series({ symbol: 'sh000001', interval: 'minute', count: 2 }, new AbortController().signal))],
    ['tencent', 'daily', async () => requireItems(await tencent.series({ symbol: 'sh000001', interval: 'day', count: 2 }, new AbortController().signal))],
    ['tencent', 'auction', async () => requireItems(await tencent.auction(['sh000001'], 'auction', new AbortController().signal))],
    ['tencent', 'search', async () => requireItems(await tencent.search('腾讯', new AbortController().signal))],
    ['sina', 'quotes', async () => requireItems(await sina.quotes(['sh600000'], new AbortController().signal))],
    ['sina', 'sectors', async () => requireItems(await sina.sectors(new AbortController().signal))],
  ];

  for (const [provider, capability, operation] of checks) {
    currentCapability = `${provider}:${capability}`;
    const start = telemetry.length;
    let marketTimestamp = null;
    let status = 'ok';
    try {
      const value = await operation();
      marketTimestamp = newestMarketTimestamp(value.items);
    } catch (error) {
      failed = true;
      status = classifyFailure(error, telemetry.slice(start));
    }
    const requests = telemetry.slice(start);
    write(JSON.stringify({
      provider,
      capability,
      status,
      byteCount: requests.reduce((sum, { bytes }) => sum + bytes, 0),
      marketTimestamp,
    }) + '\n');
  }
  return failed ? 1 : 0;
}

class SmokeFailure extends Error {
  constructor(category) {
    super(category);
    this.category = category;
  }
}

function classifyFailure(error, requests) {
  const requestFailure = requests.find(({ failure }) => failure !== null)?.failure;
  if (FAILURE_CATEGORIES.has(requestFailure)) return requestFailure;
  return error instanceof SmokeFailure && FAILURE_CATEGORIES.has(error.category) ? error.category : 'parse';
}

function contentTypeMatches(capability, rawContentType) {
  const contentType = rawContentType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (capability?.startsWith('tencent:') && capability !== 'tencent:search') {
    // The reviewed Tencent JSON endpoints currently label successful JSON as
    // text/html. The provider still requires JSON.parse to succeed, so an HTML
    // error document is classified as a parse failure rather than accepted.
    return contentType === 'application/json' || contentType.endsWith('+json') || contentType === 'text/html';
  }
  if (capability === 'tencent:search') return contentType.startsWith('text/');
  if (capability?.startsWith('sina:')) {
    return contentType.startsWith('text/')
      || contentType === 'application/javascript'
      || contentType === 'application/x-javascript';
  }
  return false;
}

function requireItems(result) {
  if (!result || !Array.isArray(result.items) || result.items.length === 0) throw new SmokeFailure('empty');
  return result;
}

function newestMarketTimestamp(items) {
  const candidates = items.flatMap((item) => {
    const value = typeof item.marketTime === 'string' ? item.marketTime : typeof item.timestamp === 'string' ? item.timestamp : null;
    return value === null || !Number.isFinite(Date.parse(value)) ? [] : [value];
  });
  return candidates.sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

function hasSensitiveHeader(headers) {
  if (headers === undefined) return false;
  const normalized = new Headers(headers);
  return ['authorization', 'cookie', 'proxy-authorization'].some((name) => normalized.has(name));
}

function assertReviewedUrl(url) {
  const value = url.toString();
  const minuteSymbols = new Set(['sh000001', 'hkHSI']);
  if (url.origin === 'https://web.ifzq.gtimg.cn' && url.pathname === '/appstock/app/minute/query') {
    assert.equal(value.startsWith(TENCENT_MINUTE_URL.split('{code}')[0]), true);
    assert.equal(minuteSymbols.has(url.searchParams.get('code')), true);
    assert.equal(url.searchParams.get('r'), '0.1');
    return;
  }
  if (url.origin === 'https://web.ifzq.gtimg.cn' && url.pathname === '/appstock/app/fqkline/get') {
    assert.equal(TENCENT_KLINE_URL.includes('/appstock/app/fqkline/get'), true);
    assert.equal(url.searchParams.get('param'), 'sh000001,day,,,2,qfq');
    return;
  }
  if (url.origin === 'https://smartbox.gtimg.cn' && url.pathname === '/s3/') {
    assert.equal(TENCENT_SMARTBOX_URL.includes('/s3/'), true);
    assert.equal(url.searchParams.get('v'), '2');
    assert.equal(url.searchParams.get('q'), '腾讯');
    assert.equal(url.searchParams.get('t'), 'all');
    return;
  }
  if (value === SINA_QUOTE_URL.replace('{symbols}', 'sh600000') || value === SINA_INDUSTRY_URL || value === SINA_CONCEPT_URL) return;
  throw new Error('unreviewed live-smoke URL');
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (entry === import.meta.url) {
  if (process.env.DSH_MARKET_LIVE_SMOKE !== '1') {
    process.stderr.write('Live smoke is opt-in. Set DSH_MARKET_LIVE_SMOKE=1 and run again.\n');
    process.exitCode = 2;
  } else {
    process.exitCode = await runLiveSmoke().catch(() => 1);
  }
}
