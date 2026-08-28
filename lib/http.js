export class SharedRequestLimiter {
    limit;
    lifecycle = new AbortController();
    queue = [];
    idleWaiters = new Set();
    active = 0;
    disposal = null;
    constructor(limit) {
        this.limit = limit;
        if (!Number.isSafeInteger(limit) || limit < 1)
            throw new Error('request concurrency must be a positive integer');
    }
    run(signal, task) {
        if (!(signal instanceof AbortSignal))
            throw new Error('request limiter signal is required');
        if (typeof task !== 'function')
            throw new Error('request limiter task is required');
        const operationSignal = AbortSignal.any([signal, this.lifecycle.signal]);
        if (operationSignal.aborted)
            return Promise.reject(signalReason(operationSignal));
        if (this.active < this.limit) {
            this.active++;
            return this.execute(operationSignal, task);
        }
        return this.acquire(operationSignal).then(() => this.execute(operationSignal, task));
    }
    async execute(operationSignal, task) {
        try {
            if (operationSignal.aborted)
                throw signalReason(operationSignal);
            return await task(operationSignal);
        }
        finally {
            this.release();
        }
    }
    dispose() {
        if (this.disposal)
            return this.disposal;
        this.lifecycle.abort(new DOMException('Request limiter is disposing', 'AbortError'));
        this.disposal = this.active === 0
            ? Promise.resolve()
            : new Promise((resolve) => this.idleWaiters.add(resolve));
        return this.disposal;
    }
    acquire(signal) {
        if (signal.aborted)
            return Promise.reject(signalReason(signal));
        if (this.active < this.limit) {
            this.active++;
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            const request = {
                signal,
                resolve,
                reject,
                onAbort: () => {
                    const index = this.queue.indexOf(request);
                    if (index < 0)
                        return;
                    this.queue.splice(index, 1);
                    signal.removeEventListener('abort', request.onAbort);
                    reject(signalReason(signal));
                },
            };
            this.queue.push(request);
            signal.addEventListener('abort', request.onAbort, { once: true });
            if (signal.aborted)
                request.onAbort();
        });
    }
    release() {
        this.active--;
        if (this.active < 0)
            throw new Error('request limiter active count became negative');
        this.startQueuedWork();
        if (this.active === 0 && this.lifecycle.signal.aborted) {
            for (const resolve of [...this.idleWaiters])
                resolve();
            this.idleWaiters.clear();
        }
    }
    startQueuedWork() {
        while (this.active < this.limit && this.queue.length > 0) {
            const request = this.queue.shift();
            request.signal.removeEventListener('abort', request.onAbort);
            if (request.signal.aborted) {
                request.reject(signalReason(request.signal));
                continue;
            }
            this.active++;
            request.resolve();
        }
    }
}
const ALLOWED = new Map([
    ['web.ifzq.gtimg.cn', ['/appstock/app/minute/query', '/appstock/app/fqkline/get']],
    ['smartbox.gtimg.cn', ['/s3/']],
    ['hq.sinajs.cn', ['/list=']],
]);
const FIXED_SINA_SECTOR_URLS = new Set([
    'https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php',
    'https://money.finance.sina.com.cn/q/view/newFLJK.php?param=class',
]);
export async function fixedGet(request, fetchImpl, signal, timeoutSignal = (timeoutMs) => AbortSignal.timeout(timeoutMs)) {
    assertAllowed(request.url);
    if (request.referer !== undefined && request.referer !== 'https://finance.sina.com.cn/') {
        throw new Error('Header not allowed');
    }
    const timeout = timeoutSignal(request.timeoutMs);
    const requestSignal = AbortSignal.any([signal, timeout]);
    let response;
    try {
        response = await fetchImpl(request.url, {
            method: 'GET',
            redirect: 'manual',
            credentials: 'omit',
            headers: request.referer === undefined ? undefined : { referer: request.referer },
            signal: requestSignal,
        });
    }
    catch {
        throw new Error('HTTP request failed');
    }
    if (response.status >= 300 && response.status < 400) {
        throw new Error('HTTP redirect rejected');
    }
    if (response.status !== 200) {
        throw new Error('HTTP status ' + response.status);
    }
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null) {
        if (!/^\d+$/.test(declaredLength))
            throw new Error('Invalid content length');
        if (Number(declaredLength) > request.maxBytes)
            throw new Error('Response too large');
    }
    const body = await readBounded(response.body, request.maxBytes, requestSignal);
    const contentEncoding = response.headers.get('content-encoding')?.trim().toLowerCase();
    const bodyWasEncoded = contentEncoding !== undefined && contentEncoding !== '' && contentEncoding !== 'identity';
    if (!bodyWasEncoded && declaredLength !== null && body.byteLength !== Number(declaredLength)) {
        throw new Error('Content length mismatch');
    }
    return body;
}
function assertAllowed(url) {
    const paths = ALLOWED.get(url.hostname);
    const allowedPath = paths?.some((path) => isAllowedPath(url.pathname, path)) ?? false;
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || (url.port !== '' && url.port !== '443') || (!allowedPath && !FIXED_SINA_SECTOR_URLS.has(url.toString()))) {
        throw new Error('Host not allowed');
    }
}
function isAllowedPath(pathname, allowedPath) {
    return pathname === allowedPath
        || ((allowedPath.endsWith('/') || allowedPath.endsWith('=')) && pathname.startsWith(allowedPath));
}
async function readBounded(body, maxBytes, signal) {
    if (!body)
        return new Uint8Array();
    const reader = body.getReader();
    const chunks = [];
    let length = 0;
    try {
        while (true) {
            if (signal.aborted)
                throw new Error('HTTP request failed');
            const next = await reader.read();
            if (next.done)
                break;
            length += next.value.byteLength;
            if (length > maxBytes) {
                await reader.cancel();
                throw new Error('Response too large');
            }
            chunks.push(next.value);
        }
    }
    catch (error) {
        if (error instanceof Error && error.message === 'Response too large')
            throw error;
        throw new Error('HTTP request failed');
    }
    finally {
        reader.releaseLock();
    }
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
}
function signalReason(signal) {
    return signal.reason ?? new DOMException('Request aborted', 'AbortError');
}
