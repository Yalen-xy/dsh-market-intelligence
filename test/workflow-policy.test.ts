import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const workflowRoot = path.join(process.cwd(), '.github', 'workflows');

test('CI keeps build, test, and package gates and adds both Windows installer shells', async () => {
  const workflow = await readFile(path.join(workflowRoot, 'ci.yml'), 'utf8');

  assert.match(workflow, /^['"]on['"]:/m);
  assert.match(workflow, /actions\/checkout@v4/);
  assert.match(workflow, /actions\/setup-node@v4/);
  assert.match(workflow, /node-version:\s*24/);
  assert.match(workflow, /cache:\s*npm/);
  assertInOrder(workflow, [
    'npm ci',
    'npm run build',
    'npm test',
    'npm run test:installer:windows-powershell',
    'npm run test:installer:pwsh',
    'npm pack --dry-run --ignore-scripts',
  ]);
});

test('Release is tag-only, Windows-only, and scopes write permission to its job', async () => {
  const workflow = await readFile(path.join(workflowRoot, 'release.yml'), 'utf8');

  assert.match(workflow, /^['"]on['"]:\s*\r?\n\s+push:\s*\r?\n\s+tags:\s*\r?\n\s+- ['"]v\*['"]\s*$/m);
  assert.doesNotMatch(workflow, /^\s{2}(pull_request|workflow_dispatch|schedule):/m);
  assert.match(workflow, /^permissions:\s*\r?\n\s+contents:\s*read\s*$/m);
  assert.doesNotMatch(workflow, /^permissions:\s*\r?\n\s+contents:\s*write\s*$/m);

  const releaseJob = extractJob(workflow, 'release');
  assert.match(releaseJob, /runs-on:\s*windows-latest/);
  assert.match(releaseJob, /^\s{4}permissions:\s*\r?\n\s{6}contents:\s*write\s*$/m);
});

test('Release validates the package and both PowerShell environments before publishing exactly staged assets', async () => {
  const workflow = await readFile(path.join(workflowRoot, 'release.yml'), 'utf8');
  const releaseJob = extractJob(workflow, 'release');

  assert.match(releaseJob, /actions\/checkout@v4/);
  assert.match(releaseJob, /actions\/setup-node@v4/);
  assert.match(releaseJob, /node-version:\s*24/);
  assert.match(releaseJob, /cache:\s*npm/);
  assertInOrder(releaseJob, [
    'npm ci',
    'npm run build',
    'npm test',
    'npm run test:load-profile',
    'npm run test:installer:windows-powershell',
    'npm run test:installer:pwsh',
    'npm pack --dry-run --ignore-scripts',
    'npm pack --ignore-scripts --json',
    'node scripts/stage-release.mjs',
    'gh release create',
  ]);

  assert.match(releaseJob, /--tag\s+\$env:GITHUB_REF_NAME/);
  assert.match(releaseJob, /--package\s+\$packageFile/);
  assert.match(releaseJob, /--output\s+\.release/);
  const publishStep = extractStep(releaseJob, 'Publish GitHub Release');
  const publishCommand = /gh release create[\s\S]*?--verify-tag/.exec(publishStep)?.[0];
  assert.ok(publishCommand, 'expected one verified gh release create invocation');
  assert.equal((publishStep.match(/gh release create/g) ?? []).length, 1);
  assert.doesNotMatch(publishCommand, /[*?]/);
  assert.deepEqual(
    [...publishCommand.matchAll(/\.release\\[^\s`]+/g)].map(([asset]) => asset),
    [
      '.release\\dsh-market-intelligence-${version}.tgz',
      '.release\\install.ps1',
      '.release\\uninstall.ps1',
      '.release\\SHA256SUMS.txt',
      '.release\\LICENSE.txt',
    ],
  );
  assert.match(publishStep, /GITHUB_REF_NAME\s+-cnotmatch\s+'\^v\(0\|\[1-9\]\\d\*\)\\\.\(0\|\[1-9\]\\d\*\)\\\.\(0\|\[1-9\]\\d\*\)\$'/);
  assert.match(publishStep, /Get-ChildItem\s+-LiteralPath\s+\.release/);
  assert.match(releaseJob, /--verify-tag/);
  assert.match(releaseJob, /--notes-file\s+\.release-notes\.md/);
  assert.doesNotMatch(releaseJob, /GITHUB_ENV|env\.PACKAGE_FILE/);
});

test('Release publication alone receives GH_TOKEN and notes are fixed, local, and disclaimer-bearing', async () => {
  const workflow = await readFile(path.join(workflowRoot, 'release.yml'), 'utf8');
  const releaseJob = extractJob(workflow, 'release');
  const tokenLines = workflow.split(/\r?\n/).filter((line) => line.includes('GH_TOKEN:'));

  assert.deepEqual(tokenLines.map((line) => line.trim()), ['GH_TOKEN: ${{ github.token }}']);
  const publishStep = extractStep(releaseJob, 'Publish GitHub Release');
  assert.match(publishStep, /GH_TOKEN:\s*\$\{\{ github\.token \}\}/);
  assert.match(releaseJob, /Set-Content\s+-LiteralPath\s+\.release-notes\.md/);
  assert.match(releaseJob, /not investment advice/i);
  assert.match(releaseJob, /Tencent and Sina are not partners/i);
  assert.match(releaseJob, /upstream endpoints may change or become unavailable/i);

  assert.doesNotMatch(workflow, /uses:\s*[^\s]+\/[^\s]+release[^\s]*/i);
  assert.doesNotMatch(workflow, /smoke:live|LIVE_PROVIDER|TENCENT_SMOKE|SINA_SMOKE/i);
});

function assertInOrder(text: string, fragments: string[]) {
  let previous = -1;
  for (const fragment of fragments) {
    const current = text.indexOf(fragment);
    assert.ok(current > previous, `expected ${JSON.stringify(fragment)} after the previous workflow gate`);
    previous = current;
  }
}

function extractJob(workflow: string, jobName: string) {
  const match = new RegExp(`^  ${jobName}:\\r?\\n([\\s\\S]*?)(?=^  [A-Za-z0-9_-]+:\\r?$|(?![\\s\\S]))`, 'm').exec(workflow);
  assert.ok(match, `expected ${jobName} job`);
  return match[0];
}

function extractStep(job: string, stepName: string) {
  const escapedName = stepName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^      - name: ${escapedName}\\r?\\n([\\s\\S]*?)(?=^      - name: |(?![\\s\\S]))`, 'm').exec(job);
  assert.ok(match, `expected ${stepName} step`);
  return match[0];
}
