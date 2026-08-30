import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

const shells = ['powershell.exe', 'pwsh'] as const;
const manifestCases = ['valid', 'case-duplicate', 'unicode', 'duplicate-hash', 'malformed', 'missing', 'extra'] as const;

test('documented latest and pinned bootstraps enforce the exact Release manifest in PowerShell 5.1 and 7', async () => {
  const readme = await readFile(path.join(process.cwd(), 'README.md'), 'utf8');
  const blocks = [...readme.matchAll(/^```powershell\r?\n(?<code>[\s\S]*?)\r?\n```$/gm)].map((match) => match.groups?.code ?? '');
  assert.ok(blocks.length >= 2, 'README must contain latest and pinned PowerShell bootstraps');

  for (const [bootstrapIndex, documentedBootstrap] of blocks.slice(0, 2).entries()) {
    for (const shell of shells) {
      for (const manifestCase of manifestCases) {
        await testBootstrap({ bootstrapIndex, documentedBootstrap, shell, manifestCase });
      }
    }
  }
});

async function testBootstrap(options: {
  bootstrapIndex: number;
  documentedBootstrap: string;
  shell: (typeof shells)[number];
  manifestCase: (typeof manifestCases)[number];
}): Promise<void> {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'dsh-bootstrap-test-'));
  const sentinel = path.join(fixtureRoot, 'executed.json');
  const installer = Buffer.from([
    '[CmdletBinding()]',
    'param([string]$Version, [uri]$ReleaseApiUri, [switch]$AcceptLicense)',
    "if (-not $AcceptLicense) { throw 'license_not_accepted' }",
    "$record = [ordered]@{ version = $Version; api = $ReleaseApiUri.AbsoluteUri; accepted = [bool]$AcceptLicense }",
    "[IO.File]::WriteAllText($env:BOOTSTRAP_SENTINEL, ($record | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))",
  ].join('\r\n'), 'utf8');
  const version = '0.1.0';
  const manifest = createManifest(options.manifestCase, installer, version);
  const server = createServer((request, response) => {
    const requestPath = request.url ?? '';
    if (requestPath === '/latest' || requestPath === '/tags/v0.1.0') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ tag_name: 'v0.1.0' }));
      return;
    }
    if (requestPath === '/download/v0.1.0/install.ps1') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(installer);
      return;
    }
    if (requestPath === '/download/v0.1.0/SHA256SUMS.txt') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(manifest);
      return;
    }
    response.writeHead(404);
    response.end();
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    const bootstrap = localizeBootstrap(options.documentedBootstrap, options.bootstrapIndex, origin);
    const result = await runPowerShell(options.shell, bootstrap, sentinel);
    const executed = await readFile(sentinel, 'utf8').then(() => true, () => false);

    if (options.manifestCase === 'valid') {
      assert.equal(result.code, 0, `${options.shell} bootstrap failed: ${result.stderr}`);
      assert.equal(executed, true, `${options.shell} did not execute the verified installer`);
      const record = JSON.parse(await readFile(sentinel, 'utf8')) as { version: string; api: string; accepted: boolean };
      assert.equal(record.version, version);
      assert.equal(record.accepted, true);
      assert.match(record.api, new RegExp(`^${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(?:latest|tags/v0\\.1\\.0)$`));
    } else {
      assert.notEqual(result.code, 0, `${options.shell} accepted ${options.manifestCase} manifest`);
      assert.equal(executed, false, `${options.shell} executed installer for ${options.manifestCase} manifest`);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

function createManifest(kind: (typeof manifestCases)[number], installer: Buffer, version: string): string {
  const installerHash = createHash('sha256').update(installer).digest('hex');
  const rows = [
    `${installerHash}  install.ps1`,
    `${'1'.repeat(64)}  uninstall.ps1`,
    `${'2'.repeat(64)}  dsh-market-intelligence-${version}.tgz`,
    `${'3'.repeat(64)}  LICENSE.txt`,
  ];
  if (kind === 'case-duplicate') rows.push(`${'4'.repeat(64)}  INSTALL.ps1`);
  if (kind === 'unicode') rows.push(`${'4'.repeat(64)}  instаll.ps1`);
  if (kind === 'duplicate-hash') rows[1] = `${installerHash}  uninstall.ps1`;
  if (kind === 'malformed') rows.push('not a canonical checksum row');
  if (kind === 'missing') rows.pop();
  if (kind === 'extra') rows.push(`${'4'.repeat(64)}  unexpected.txt`);
  return `${rows.join('\n')}\n`;
}

function localizeBootstrap(documented: string, index: number, origin: string): string {
  if (index === 0) {
    return documented
      .replace('https://api.github.com/repos/Yalen-xy/dsh-market-intelligence/releases/latest', `${origin}/latest`)
      .replace('https://github.com/Yalen-xy/dsh-market-intelligence/releases/download/$tag', `${origin}/download/$tag`);
  }
  return documented
    .replace('https://api.github.com/repos/Yalen-xy/dsh-market-intelligence/releases/tags/v0.1.0', `${origin}/tags/v0.1.0`)
    .replace('https://github.com/Yalen-xy/dsh-market-intelligence/releases/download/v0.1.0', `${origin}/download/v0.1.0`);
}

async function runPowerShell(shell: (typeof shells)[number], script: string, sentinel: string): Promise<{ code: number | null; stderr: string }> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    env: { ...process.env, BOOTSTRAP_SENTINEL: sentinel },
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    return { code, stderr };
  } finally {
    clearTimeout(timer);
  }
}
