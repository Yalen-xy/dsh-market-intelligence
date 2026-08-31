import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

const exactTools = [
  'market_auction',
  'market_data_health',
  'market_quotes',
  'market_sectors',
  'market_series',
  'market_status',
  'market_watchlist',
];

const sourceRiskNotice =
  'Use is limited to personal, non-commercial, read-only research. Tencent and Sina are not partners of, and have not authorized, this project. Their unofficial interfaces may change, fail, or become unavailable without notice. You are responsible for compliance with applicable law and upstream terms. Nothing in this project or License grants third-party authorization or guarantees legal compliance.';

test('package ships the limited-use license and no user-specific storage path', async () => {
  const root = process.cwd();
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as Record<string, unknown>;

  assert.equal(packageJson.license, 'SEE LICENSE IN LICENSE');
  assert.equal(packageJson.private, true);
  assert.deepEqual(packageJson.files, ['lib', 'cordis.patch.yml', 'README.md', 'LICENSE', 'docs/INSTALL.md', 'scripts']);

  const patch = await readFile(path.join(root, 'cordis.patch.yml'), 'utf8');
  assert.doesNotMatch(patch, /D:\\AI|storageDir:/i);

  const license = await readFile(path.join(root, 'LICENSE'), 'utf8');
  for (const section of [
    'Personal Non-Commercial Limited Use License',
    'Copyright (c) 2026 Yalen-xy. All rights reserved.',
    'Limited License Grant',
    'Personal Non-Commercial Use Only',
    'No Modification',
    'No Redistribution',
    'No Commercial or Hosted Use',
    'No Market Data Redistribution',
    'Third-Party Services',
    'Termination',
    'No Warranty',
    'Limitation of Liability',
    'Reservation of Rights',
  ]) {
    assert.match(license, new RegExp(section.replace(/[().]/g, '\\$&')));
  }
  assert.match(license, /unmodified official Release/i);
  assert.match(license, /personal computers/i);
  assert.match(license, /non-commercial research/i);
});

test('license bytes are pinned to LF for the installer package hash on every checkout', async () => {
  const attributes = await readFile(path.join(process.cwd(), '.gitattributes'), 'utf8');
  assert.match(attributes, /^LICENSE text eol=lf$/m);
});

test('README provides two versionless customer downloads and keeps advanced commands in the install guide', async () => {
  const root = process.cwd();
  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  const installGuide = await readFile(path.join(root, 'docs', 'INSTALL.md'), 'utf8');
  const installerReadme = await readFile(path.join(root, 'installer', 'README.md'), 'utf8');
  const combined = [readme, installGuide, installerReadme].join('\n');

  assert.match(readme, /https:\/\/github\.com\/Yalen-xy\/dsh-market-intelligence\/releases\/latest\/download\/dsh-market-intelligence-latest\.zip/);
  assert.match(readme, /https:\/\/github\.com\/Yalen-xy\/dsh-market-intelligence\/releases\/latest\/download\/claude-market-intelligence-latest\.mcpb/);
  assert.match(readme, /INSTALL\.cmd/);
  assert.doesNotMatch(readme, /v\d+\.\d+\.\d+|```(?:powershell|cmd|bat)?/i);
  assert.doesNotMatch(readme, /Invoke-WebRequest|Invoke-RestMethod|SHA256SUMS\.txt|-AcceptLicense/);
  assert.doesNotMatch(combined, /\bGet-FileHash\b/);
  assert.doesNotMatch(combined, /\b(?:Invoke-Expression|iex)\b/i);
  assert.match(installGuide, /SHA256SUMS\.txt/);
  assert.match(installGuide, /-AcceptLicense/);
});

test('Claude documentation describes the Windows extension boundary without publishing local configuration details', async () => {
  const root = process.cwd();
  const claudeGuide = await readFile(path.join(root, 'docs', 'CLAUDE.md'), 'utf8');
  const architecture = await readFile(path.join(root, 'docs', 'ARCHITECTURE.md'), 'utf8');

  assert.match(claudeGuide, /Settings\s*→\s*Extensions\s*→\s*Advanced settings\s*→\s*Install Extension/);
  assert.match(claudeGuide, /claude-market-intelligence-latest\.mcpb/);
  assert.match(claudeGuide, /Windows/i);
  assert.match(claudeGuide, /(?:无需|不需要)手动(?:执行)?\s*npm|no manual npm/i);
  assert.match(claudeGuide, /(?:无需|不需要)手动.*JSON|no manual JSON/i);
  assert.match(claudeGuide, /D:\\[^\r\n`]+/);
  assert.match(claudeGuide, /Claude.*DSH|DSH.*Claude/i);
  assert.match(claudeGuide, /(?:独立|independent)[^\n]*(?:数据库|database)|(?:数据库|database)[^\n]*(?:独立|independent)/i);
  assert.match(claudeGuide, /卸载|uninstall/i);
  assert.match(claudeGuide, /诊断|diagnostic/i);

  for (const tool of exactTools) {
    assert.match(claudeGuide, new RegExp(`\\b${tool}\\b`));
  }

  assert.match(claudeGuide, /不构成投资建议/);
  assert.ok(claudeGuide.includes(sourceRiskNotice), 'Claude guide must carry the canonical source-risk notice');
  assert.match(claudeGuide, /https:\/\/www\.tencent\.com\/privacy-policy\//);
  assert.match(claudeGuide, /https:\/\/corp\.sina\.com\.cn\/eng\/sina_priv_eng\.htm/);
  assert.match(architecture, /shared|共享/i);
  assert.match(architecture, /Codex[\s\S]{0,120}(?:planned|计划|reserved|预留)/i);
  assert.match(architecture, /no Codex adapter is currently available/i);

  for (const content of [claudeGuide, architecture]) {
    assert.doesNotMatch(content, /DSH Desktop/i);
    assert.doesNotMatch(content, /D:\\AI/i);
    assert.doesNotMatch(content, /claude_desktop_config\.json|%APPDATA%|%LOCALAPPDATA%/i);
    assert.doesNotMatch(content, /\.map\b|source map/i);
    assert.doesNotMatch(content, /(?:ghp_|github_pat_)[A-Za-z0-9_]+|Authorization:\s*Bearer|password\s*[:=]\s*[^<\s]/i);
    assert.doesNotMatch(content, /(?:endorsed by|authorized by|affiliated with)\s+(?:Anthropic|Tencent|Sina|DeepSeek)/i);
    assert.doesNotMatch(content, /(?:Anthropic|Tencent|Sina|DeepSeek)[^\n]*(?:is a partner|has authorized|official endorsement)/i);
  }
});

test('installation documentation matches installer behavior and recovery boundaries', async () => {
  const root = process.cwd();
  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  const installGuide = await readFile(path.join(root, 'docs', 'INSTALL.md'), 'utf8');
  const installerReadme = await readFile(path.join(root, 'installer', 'README.md'), 'utf8');
  const combined = [readme, installGuide, installerReadme].join('\n');

  for (const parameter of ['-DshHome', '-DshCommand', '-Version', '-AllowDowngrade', '-AcceptLicense', '-WhatIf']) {
    assert.match(installGuide, new RegExp(parameter.replace('-', '\\-'), 'i'));
  }
  assert.match(installGuide, /does not expose a `-StorageRoot` parameter/i);
  assert.match(combined, /DSH Desktop[^\n]*(?:running|退出|关闭)[^\n]*(?:refus|拒绝|停止)/i);
  assert.match(installGuide, /manual|手动/i);
  assert.match(installGuide, /offline|离线/i);
  assert.match(installGuide, /upgrade|升级/i);
  assert.match(installGuide, /downgrade|降级/i);
  assert.match(installGuide, /rollback|回滚/i);
  assert.match(installGuide, /installer\.log/i);
  assert.match(combined, /%DSH_HOME%\\storages\\dsh-market-intelligence/i);
  assert.match(combined, /explicit storage root|显式[^\n]*存储/i);
  assert.match(combined, /pre-restart|重启前/i);
  assert.match(combined, /does not prove runtime registration|不(?:能|代表|等于)[^\n]*运行时注册/i);
  for (const tool of exactTools) {
    assert.match(installGuide, new RegExp(`\\b${tool}\\b`));
  }
});

test('public documentation carries consistent limited-use and provider-risk terms', async () => {
  const root = process.cwd();
  const files = ['README.md', 'docs/INSTALL.md', 'docs/CLAUDE.md', 'LICENSE', 'SECURITY.md'];

  for (const relativePath of files) {
    const content = await readFile(path.join(root, ...relativePath.split('/')), 'utf8');
    assert.match(content, /personal, non-commercial, read-only research/i, relativePath);
    assert.match(content, /Tencent and Sina are not partners of, and have not authorized, this project/i, relativePath);
    assert.match(content, /unofficial interfaces may change, fail, or become unavailable without notice/i, relativePath);
    assert.match(content, /responsible for compliance with applicable law and upstream terms/i, relativePath);
    assert.match(content, /does not|Nothing[^\n]+(?:authorization|legal compliance)/i, relativePath);
    assert.ok(content.includes(sourceRiskNotice), `${relativePath} must carry the canonical source-risk notice`);
  }
});

test('public and packaged documentation contains no developer-specific path, wrapper, secret, or authorization guarantee', async () => {
  const root = process.cwd();
  const files = ['README.md', 'docs/INSTALL.md', 'docs/CLAUDE.md', 'installer/README.md', 'LICENSE', 'SECURITY.md', 'CHANGELOG.md', 'cordis.patch.yml'];

  for (const relativePath of files) {
    const content = await readFile(path.join(root, ...relativePath.split('/')), 'utf8');
    assert.doesNotMatch(content, /D:\\AI/i, relativePath);
    assert.doesNotMatch(content, /dsh-tools\\bin\\dsh\.ps1/i, relativePath);
    assert.doesNotMatch(content, /(?:ghp_|github_pat_)[A-Za-z0-9_]+|Authorization:\s*Bearer|password\s*[:=]\s*[^<\s]/i, relativePath);
    assert.doesNotMatch(content, /(?:Tencent|Sina)[^\n]*(?:officially authorized|合法授权|已授权)/i, relativePath);
  }
});
