import { createServer, type Server } from 'node:http';

export interface ReleaseFixture {
  apiUrl: string;
  close(): Promise<void>;
  requests: string[];
}

export async function startReleaseServer(options: {
  assets: Record<string, Buffer>;
  tagName: string;
}): Promise<ReleaseFixture> {
  const requests: string[] = [];
  let origin = '';
  const server: Server = createServer((request, response) => {
    const requestPath = request.url ?? '/';
    requests.push(requestPath);
    if (request.method !== 'GET') {
      response.writeHead(405).end();
      return;
    }
    if (requestPath === '/release') {
      const assets = Object.keys(options.assets).sort().map((name) => ({
        browser_download_url: `${origin}/assets/${encodeURIComponent(name)}`,
        name,
      }));
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ assets, tag_name: options.tagName }));
      return;
    }
    const prefix = '/assets/';
    if (requestPath.startsWith(prefix)) {
      const name = decodeURIComponent(requestPath.slice(prefix.length));
      const content = options.assets[name];
      if (content !== undefined) {
        response.writeHead(200, { 'content-length': content.length, 'content-type': 'application/octet-stream' });
        response.end(content);
        return;
      }
    }
    response.writeHead(404).end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeServer(server);
    throw new Error('loopback release fixture did not expose a TCP address');
  }
  origin = `http://127.0.0.1:${address.port}`;
  return {
    apiUrl: `${origin}/release`,
    close: () => closeServer(server),
    requests,
  };
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}
