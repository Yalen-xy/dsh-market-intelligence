import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { test, type TestContext } from 'node:test';
import { runInstallerPowerShell } from './helpers/installer.ts';
import { startReleaseServer, type ReleaseFixture } from './fixtures/release-server.ts';

const execFileAsync = promisify(execFile);
const fakeDshPath = path.join(process.cwd(), 'test', 'fixtures', 'fake-dsh.ps1');

test('first install uses verified loopback release and preserves unrelated profile and storage bytes', async (t) => {
  const fixture = await createLifecycleFixture(t, '0.1.0');
  const beforeStorage = await hashTree(fixture.storageRoot);
  const result = await invokeLifecycle(t, fixture, { acceptLicense: true, version: '0.1.0' });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /restart_required/);
  const profile = JSON.parse(await readFile(fixture.profilePackagePath, 'utf8')) as {
    bundles: string[];
    credentials: { token: string };
    dependencies: Record<string, string>;
  };
  assert.equal(profile.dependencies.unrelated, '9.9.9');
  assert.equal(profile.dependencies['dsh-market-intelligence'], '0.1.0');
  assert.deepEqual(profile.bundles, ['unrelated-bundle', 'dsh-market-intelligence']);
  assert.equal(profile.credentials.token, 'credential-secret-123');
  assert.equal(await hashTree(fixture.storageRoot), beforeStorage);
  assert.deepEqual(await readCalls(fixture.callLog), ['identity', 'capability', 'add', 'validate']);
  assert.deepEqual(fixture.server.requests, [
    '/release',
    '/assets/SHA256SUMS.txt',
    '/assets/dsh-market-intelligence-0.1.0.tgz',
  ]);

  const manifests = await findFiles(path.join(fixture.dshHome, 'backups'), 'backup-manifest.json');
  assert.equal(manifests.length, 1);
  const manifest = JSON.parse(await readFile(manifests[0], 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(manifest), [
    'operationId',
    'createdAt',
    'installerVersion',
    'requestedVersion',
    'cliPath',
    'cliVersion',
    'files',
  ]);
  const rows = manifest.files as Array<Record<string, unknown>>;
  assert.deepEqual(rows.map((row) => row.relativePath).sort(), [
    'profiles\\desktop\\.dsh-market-cache\\dsh-market-intelligence-0.1.0.tgz',
    'profiles\\desktop\\.dsh-market-intelligence-receipt.json',
    'profiles\\desktop\\cordis.patch.yml',
    'profiles\\desktop\\dsh.profile.yaml',
    'profiles\\desktop\\package.json',
    'profiles\\desktop\\pnpm-lock.yaml',
  ]);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row), ['relativePath', 'existed', 'length', 'sha256']);
    if (row.existed === false) {
      assert.equal(row.length, 0);
      assert.equal(row.sha256, null);
    }
  }
});

test('direct latest install resolves the release version when Version is omitted', async (t) => {
  const fixture = await createLifecycleFixture(t, '0.1.0');
  const result = await invokeLifecycle(t, fixture, { acceptLicense: true });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /restart_required/);
  await assertInstalledState(fixture, '0.1.0');
  assert.deepEqual(fixture.server.requests, [
    '/release',
    '/assets/SHA256SUMS.txt',
    '/assets/dsh-market-intelligence-0.1.0.tgz',
  ]);
});

test('WhatIf resolves manifest plan without package download, backup, profile writes, or mutating CLI calls', async (t) => {
  const fixture = await createLifecycleFixture(t, '0.1.0');
  const beforeHome = await hashTree(fixture.dshHome);
  const result = await invokeLifecycle(t, fixture, { acceptLicense: true, version: '0.1.0', whatIf: true });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /plan_install/);
  assert.equal(await hashTree(fixture.dshHome), beforeHome);
  assert.deepEqual(await readCalls(fixture.callLog), ['identity', 'capability']);
  assert.deepEqual(fixture.server.requests, ['/release', '/assets/SHA256SUMS.txt']);
});

test('every WhatIf operation retains a unique UTF-8 temp log and discloses its exact path', async (t) => {
  const fixture = await createLifecycleFixture(t, '0.1.0');
  const first = await invokeLifecycle(t, fixture, { acceptLicense: true, version: '0.1.0', whatIf: true });
  const second = await invokeLifecycle(t, fixture, { acceptLicense: true, version: '0.1.0', whatIf: true });
  const paths = [operationLogPath(first.stdout), operationLogPath(second.stdout)];
  assert.notEqual(paths[0], paths[1]);
  for (const logPath of paths) {
    assert.equal(path.dirname(path.dirname(logPath)), path.join(fixture.root, 'installer-temp'));
    const bytes = await readFile(logPath);
    assert.equal(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false);
    const rows = bytes.toString('utf8').trim().split(/\r?\n/).map((row) => JSON.parse(row) as Record<string, unknown>);
    assert.deepEqual(rows.map((row) => row.event), ['InstallerPhase', 'InstallerResult']);
    assert.equal(rows[1].resultCode, 0);
  }
});

test('derived profile, storage, and backup roots reject intermediate junctions before touching their targets', async (t) => {
  const cases: Array<{ name: string; relativeRoot: string }> = [
    { name: 'profiles intermediate', relativeRoot: 'profiles' },
    { name: 'storages intermediate', relativeRoot: 'storages' },
    { name: 'backups intermediate', relativeRoot: 'backups' },
  ];

  for (const row of cases) {
    await t.test(row.name, async (child) => {
      const fixture = await createLifecycleFixture(child, '0.1.0');
      const linkPath = path.join(fixture.dshHome, row.relativeRoot);
      const outsideTarget = path.join(fixture.root, `outside-${row.relativeRoot}`);
      if (row.relativeRoot === 'backups') await mkdir(linkPath, { recursive: true });
      await rename(linkPath, outsideTarget);
      await writeFile(path.join(outsideTarget, 'outside-sentinel.txt'), 'outside-sentinel', 'utf8');
      await symlink(outsideTarget, linkPath, 'junction');
      const outsideBefore = await hashTree(outsideTarget);
      const profileBefore = await treeManifest(fixture.profileRoot);

      const result = await invokeLifecycle(child, fixture, { acceptLicense: true, version: '0.1.0' });

      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr, /path|reparse|profile/i);
      assert.equal(await hashTree(outsideTarget), outsideBefore);
      assert.deepEqual(await treeManifest(fixture.profileRoot), profileBefore);
      assert.equal(await readFile(path.join(outsideTarget, 'outside-sentinel.txt'), 'utf8'), 'outside-sentinel');
    });
  }
});

test('same-version reinstall verifies the selected release and remains idempotent without another backup or mutating CLI call', async (t) => {
  const fixture = await createLifecycleFixture(t, '0.1.0');
  assert.equal((await invokeLifecycle(t, fixture, { acceptLicense: true, version: '0.1.0' })).exitCode, 0);
  const profileAfterFirst = await hashTree(fixture.profileRoot);
  const callsAfterFirst = await readCalls(fixture.callLog);
  const result = await invokeLifecycle(t, fixture, { acceptLicense: true, version: '0.1.0' });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /already_installed/);
  assert.equal(await hashTree(fixture.profileRoot), profileAfterFirst);
  assert.deepEqual((await readCalls(fixture.callLog)).slice(callsAfterFirst.length), ['identity', 'capability']);
  assert.equal((await findFiles(path.join(fixture.dshHome, 'backups'), 'backup-manifest.json')).length, 1);
  assert.deepEqual(fixture.server.requests.slice(-3), [
    '/release',
    '/assets/SHA256SUMS.txt',
    '/assets/dsh-market-intelligence-0.1.0.tgz',
  ]);
});

test('same-version cache, package, and canonical receipt byte tampering cannot report already installed', async (t) => {
  const attacks: Array<{ mutate: (fixture: LifecycleFixture) => Promise<void>; name: string }> = [
    {
      name: 'cache bytes',
      mutate: async (fixture) => writeFile(path.join(fixture.profileRoot, '.dsh-market-cache', 'dsh-market-intelligence-0.1.0.tgz'), 'tampered-cache'),
    },
    {
      name: 'installed package bytes',
      mutate: async (fixture) => writeFile(path.join(fixture.profileRoot, 'node_modules', 'dsh-market-intelligence', 'lib', 'index.js'), 'tampered-package'),
    },
    {
      name: 'receipt canonical bytes',
      mutate: async (fixture) => {
        const receiptPath = path.join(fixture.profileRoot, '.dsh-market-intelligence-receipt.json');
        const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, string>;
        await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
      },
    },
  ];

  for (const row of attacks) {
    await t.test(row.name, async (child) => {
      const fixture = await createLifecycleFixture(child, '0.1.0');
      assert.equal((await invokeLifecycle(child, fixture, { acceptLicense: true, version: '0.1.0' })).exitCode, 0);
      await row.mutate(fixture);
      const tamperedProfile = await hashTree(fixture.profileRoot);
      const requestsBefore = fixture.server.requests.length;
      const result = await invokeLifecycle(child, fixture, { acceptLicense: true, version: '0.1.0' });

      assert.notEqual(result.exitCode, 0);
      assert.doesNotMatch(result.stdout, /already_installed/);
      assert.match(result.stderr, /same_version_integrity_invalid|integrity/i);
      assert.equal(await hashTree(fixture.profileRoot), tamperedProfile);
      assert.deepEqual(fixture.server.requests.slice(requestsBefore), [
        '/release',
        '/assets/SHA256SUMS.txt',
        '/assets/dsh-market-intelligence-0.1.0.tgz',
      ]);
    });
  }
});

test('same-version WhatIf plans reinstall without downloading or inspecting the package payload', async (t) => {
  const fixture = await createLifecycleFixture(t, '0.1.0');
  assert.equal((await invokeLifecycle(t, fixture, { acceptLicense: true, version: '0.1.0' })).exitCode, 0);
  const homeBefore = await hashTree(fixture.dshHome);
  const storageBefore = await hashTree(fixture.storageRoot);
  const callsBefore = await readCalls(fixture.callLog);
  const requestsBefore = fixture.server.requests.length;

  const result = await invokeLifecycle(t, fixture, { acceptLicense: true, version: '0.1.0', whatIf: true });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /plan_reinstall/);
  assert.equal(await hashTree(fixture.dshHome), homeBefore);
  assert.equal(await hashTree(fixture.storageRoot), storageBefore);
  assert.equal((await readdir(path.join(fixture.root, 'installer-temp'))).filter((name) => name.startsWith('dsh-market-installer-')).length, 0);
  assert.match(result.stdout, /installer_log=.*installer\.log/i);
  assert.deepEqual((await readCalls(fixture.callLog)).slice(callsBefore.length), ['identity', 'capability']);
  assert.deepEqual(fixture.server.requests.slice(requestsBefore), ['/release', '/assets/SHA256SUMS.txt']);
});

test('same-version WhatIf remains metadata-only when local payload bytes are damaged', async (t) => {
  const attacks: Array<{ mutate: (fixture: LifecycleFixture) => Promise<void>; name: string }> = [
    {
      name: 'cache bytes',
      mutate: async (fixture) => writeFile(path.join(fixture.profileRoot, '.dsh-market-cache', 'dsh-market-intelligence-0.1.0.tgz'), 'tampered-cache'),
    },
    {
      name: 'installed package bytes',
      mutate: async (fixture) => writeFile(path.join(fixture.profileRoot, 'node_modules', 'dsh-market-intelligence', 'lib', 'index.js'), 'tampered-package'),
    },
    {
      name: 'receipt canonical bytes',
      mutate: async (fixture) => {
        const receiptPath = path.join(fixture.profileRoot, '.dsh-market-intelligence-receipt.json');
        const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, string>;
        await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
      },
    },
  ];

  for (const row of attacks) {
    await t.test(row.name, async (child) => {
      const fixture = await createLifecycleFixture(child, '0.1.0');
      assert.equal((await invokeLifecycle(child, fixture, { acceptLicense: true, version: '0.1.0' })).exitCode, 0);
      await row.mutate(fixture);
      const homeBefore = await hashTree(fixture.dshHome);
      const storageBefore = await hashTree(fixture.storageRoot);
      const callsBefore = await readCalls(fixture.callLog);
      const requestsBefore = fixture.server.requests.length;

      const result = await invokeLifecycle(child, fixture, { acceptLicense: true, version: '0.1.0', whatIf: true });

      assert.equal(result.exitCode, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /plan_reinstall/);
      assert.equal(await hashTree(fixture.dshHome), homeBefore);
      assert.equal(await hashTree(fixture.storageRoot), storageBefore);
      assert.equal((await readdir(path.join(fixture.root, 'installer-temp'))).filter((name) => name.startsWith('dsh-market-installer-')).length, 0);
      assert.match(result.stdout, /installer_log=.*installer\.log/i);
      assert.deepEqual((await readCalls(fixture.callLog)).slice(callsBefore.length), ['identity', 'capability']);
      assert.deepEqual(fixture.server.requests.slice(requestsBefore), ['/release', '/assets/SHA256SUMS.txt']);
    });
  }
});

test('same-version WhatIf creates no payload temporary directory even when cleanup failure injection is enabled', async (t) => {
  const fixture = await createLifecycleFixture(t, '0.1.0');
  assert.equal((await invokeLifecycle(t, fixture, { acceptLicense: true, version: '0.1.0' })).exitCode, 0);
  const homeBefore = await hashTree(fixture.dshHome);
  const storageBefore = await hashTree(fixture.storageRoot);

  const result = await invokeLifecycle(t, fixture, { acceptLicense: true, failCleanup: true, version: '0.1.0', whatIf: true });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /plan_reinstall/);
  assert.equal(await hashTree(fixture.dshHome), homeBefore);
  assert.equal(await hashTree(fixture.storageRoot), storageBefore);
  await assert.rejects(readFile(path.join(fixture.root, 'cleanup-attempts.log')));
  assert.equal((await findFiles(path.join(fixture.dshHome, 'backups'), 'backup-manifest.json')).length, 1);
  assert.equal((await readdir(path.join(fixture.root, 'installer-temp'))).filter((name) => name.startsWith('dsh-market-installer-')).length, 0);
});

test('upgrade and downgrade WhatIf resolve metadata and print exact plans without payload, backup, or mutation', async (t) => {
  const fixture = await createLifecycleFixture(t, '0.2.0');
  assert.equal((await invokeLifecycle(t, fixture, { acceptLicense: true, version: '0.2.0' })).exitCode, 0);
  for (const row of [
    { allowDowngrade: false, expected: /plan_upgrade/, version: '0.3.0' },
    { allowDowngrade: true, expected: /plan_downgrade/, version: '0.1.0' },
  ]) {
    await replaceRelease(t, fixture, row.version);
    const homeBefore = await hashTree(fixture.dshHome);
    const callsBefore = (await readCalls(fixture.callLog)).length;
    const requestsBefore = fixture.server.requests.length;
    const result = await invokeLifecycle(t, fixture, {
      acceptLicense: true,
      allowDowngrade: row.allowDowngrade,
      version: row.version,
      whatIf: true,
    });
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.match(result.stdout, row.expected);
    assert.equal(await hashTree(fixture.dshHome), homeBefore);
    assert.deepEqual((await readCalls(fixture.callLog)).slice(callsBefore), ['identity', 'capability']);
    assert.deepEqual(fixture.server.requests.slice(requestsBefore), ['/release', '/assets/SHA256SUMS.txt']);
  }
});

test('upgrade and explicit downgrade change only the managed package while preserving storage and unrelated state', async (t) => {
  const fixture = await createLifecycleFixture(t, '0.1.0');
  const storageBefore = await hashTree(fixture.storageRoot);
  assert.equal((await invokeLifecycle(t, fixture, { acceptLicense: true, version: '0.1.0' })).exitCode, 0);

  await replaceRelease(t, fixture, '0.2.0');
  const upgrade = await invokeLifecycle(t, fixture, { acceptLicense: true, version: '0.2.0' });
  assert.equal(upgrade.exitCode, 0, upgrade.stderr || upgrade.stdout);
  await assertInstalledState(fixture, '0.2.0');

  await replaceRelease(t, fixture, '0.1.0');
  const downgrade = await invokeLifecycle(t, fixture, { acceptLicense: true, allowDowngrade: true, version: '0.1.0' });
  assert.equal(downgrade.exitCode, 0, downgrade.stderr || downgrade.stdout);
  await assertInstalledState(fixture, '0.1.0');
  assert.equal(await hashTree(fixture.storageRoot), storageBefore);
  assert.equal((await findFiles(path.join(fixture.dshHome, 'backups'), 'backup-manifest.json')).length, 3);
});

test('downgrade is rejected by default before package download, backup, or mutation', async (t) => {
  const fixture = await createLifecycleFixture(t, '0.2.0');
  assert.equal((await invokeLifecycle(t, fixture, { acceptLicense: true, version: '0.2.0' })).exitCode, 0);
  await replaceRelease(t, fixture, '0.1.0');
  const profileBefore = await hashTree(fixture.profileRoot);
  const backupCountBefore = (await findFiles(path.join(fixture.dshHome, 'backups'), 'backup-manifest.json')).length;
  const result = await invokeLifecycle(t, fixture, { acceptLicense: true, version: '0.1.0' });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /downgrade_not_allowed/);
  assert.equal(await hashTree(fixture.profileRoot), profileBefore);
  assert.equal((await findFiles(path.join(fixture.dshHome, 'backups'), 'backup-manifest.json')).length, backupCountBefore);
  assert.doesNotMatch(fixture.server.requests.join('\n'), /\.tgz/);
});

test('license, CLI, process, checksum, and metadata gates fail before backup or profile mutation', async (t) => {
  const cases: Array<{
    arrange?: (fixture: LifecycleFixture) => Promise<void>;
    expected: RegExp;
    invoke?: { acceptLicense?: boolean; processOwned?: boolean; version?: string };
    name: string;
    options?: LifecycleFixtureOptions;
  }> = [
    { name: 'license', expected: /license_not_accepted/, invoke: { version: '0.1.0' } },
    { name: 'identity', expected: /managed_cli_identity_invalid/, arrange: (fixture) => updateControl(fixture, { invalidIdentity: true }) },
    { name: 'capability', expected: /managed_cli_capability_invalid/, arrange: (fixture) => updateControl(fixture, { missingCapability: true }) },
    { name: 'owned process', expected: /process_running/, invoke: { acceptLicense: true, processOwned: true, version: '0.1.0' } },
    { name: 'checksum', expected: /package_hash_mismatch/, options: { manifestHash: '0'.repeat(64) } },
    { name: 'metadata', expected: /package_metadata_invalid/, options: { packageName: 'wrong-package' } },
  ];

  for (const row of cases) {
    await t.test(row.name, async (child) => {
      const fixture = await createLifecycleFixture(child, '0.1.0', row.options);
      if (row.arrange !== undefined) await row.arrange(fixture);
      const before = await hashTree(fixture.profileRoot);
      const result = await invokeLifecycle(child, fixture, row.invoke ?? { acceptLicense: true, version: '0.1.0' });
      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr, row.expected);
      assert.equal(await hashTree(fixture.profileRoot), before);
      assert.equal((await findFiles(path.join(fixture.dshHome, 'backups'), 'backup-manifest.json')).length, 0);
    });
  }
});

test('license, patch, main, traversal, symlink, and hardlink archive attacks fail before backup or mutation', async (t) => {
  const cases: Array<{ expected: RegExp; name: string; variant: PackageVariant }> = [
    { name: 'wrong license bytes', variant: 'bad-license', expected: /package_license_invalid/ },
    { name: 'unsafe patch bytes', variant: 'bad-patch', expected: /package_patch_invalid/ },
    { name: 'empty compiled main', variant: 'empty-main', expected: /package_main_invalid/ },
    { name: 'archive traversal', variant: 'traversal', expected: /package_archive_invalid/ },
    { name: 'archive symlink', variant: 'symlink', expected: /package_archive_invalid/ },
    { name: 'archive hardlink', variant: 'hardlink', expected: /package_archive_invalid/ },
    { name: 'archive reserved device component', variant: 'reserved-device', expected: /package_archive_invalid/ },
  ];

  for (const row of cases) {
    await t.test(row.name, async (child) => {
      const fixture = await createLifecycleFixture(child, '0.1.0', { packageVariant: row.variant });
      const before = await hashTree(fixture.profileRoot);
      const result = await invokeLifecycle(child, fixture, { acceptLicense: true, version: '0.1.0' });
      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr, row.expected);
      assert.equal(await hashTree(fixture.profileRoot), before);
      assert.equal((await findFiles(path.join(fixture.dshHome, 'backups'), 'backup-manifest.json')).length, 0);
      assert.deepEqual(await readCalls(fixture.callLog), ['identity', 'capability']);
    });
  }
});

test('successful install preserves unrelated cache, node_modules, and coordination files byte-for-byte', async (t) => {
  const fixture = await createLifecycleFixture(t, '0.1.0');
  const unrelated = await seedUnrelatedProfileFiles(fixture);
  const result = await invokeLifecycle(t, fixture, { acceptLicense: true, version: '0.1.0' });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  await assertUnrelatedProfileFiles(unrelated);
});

test('post-install managed receipt, cache, and package violations trigger rollback', async (t) => {
  for (const postInstallMutation of ['missing-receipt', 'missing-cache', 'tamper-package']) {
    await t.test(postInstallMutation, async (child) => {
      const fixture = await createLifecycleFixture(child, '0.1.0');
      await seedUnrelatedProfileFiles(fixture);
      const profileBefore = await treeManifest(fixture.profileRoot);
      await updateControl(fixture, { postInstallMutation });
      const result = await invokeLifecycle(child, fixture, { acceptLicense: true, version: '0.1.0' });

      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr, /installation_failed_rolled_back/);
      assert.deepEqual(await treeManifest(fixture.profileRoot), profileBefore);
    });
  }
});

test('rollback restores managed coordination while preserving untouched unrelated files', async (t) => {
  const fixture = await createLifecycleFixture(t, '0.1.0');
  const unrelated = await seedUnrelatedProfileFiles(fixture);
  const profileBefore = await treeManifest(fixture.profileRoot);
  await updateControl(fixture, { failStage: 'after-coordination' });
  const result = await invokeLifecycle(t, fixture, { acceptLicense: true, version: '0.1.0' });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /installation_failed_rolled_back/);
  assert.deepEqual(await treeManifest(fixture.profileRoot), profileBefore);
  await assertUnrelatedProfileFiles(unrelated);
  assert.equal((await findFiles(fixture.profileRoot, 'transaction-created.tmp')).length, 0);
});

test('each post-mutation failure boundary restores the exact prior profile and exits nonzero after rollback', async (t) => {
  for (const failStage of ['after-package', 'after-profile', 'after-coordination']) {
    await t.test(failStage, async (child) => {
      const fixture = await createLifecycleFixture(child, '0.1.0');
      const profileManifestBefore = await treeManifest(fixture.profileRoot);
      const storageBefore = await hashTree(fixture.storageRoot);
      await updateControl(fixture, { failStage });
      const result = await invokeLifecycle(child, fixture, { acceptLicense: true, version: '0.1.0' });

      assert.notEqual(result.exitCode, 0);
      const profileAfter = await treeManifest(fixture.profileRoot);
      assert.deepEqual(profileAfter, profileManifestBefore, JSON.stringify({ after: profileAfter, before: profileManifestBefore }));
      assert.equal(await hashTree(fixture.storageRoot), storageBefore);
      assert.equal((await findFiles(path.join(fixture.dshHome, 'backups'), 'backup-manifest.json')).length, 1);
      assert.deepEqual((await readCalls(fixture.callLog)).slice(-1), ['remove']);
      assert.match(result.stderr, /installation_failed_rolled_back/);
    });
  }
});

test('failed upgrade restores the previously installed version and exact profile bytes through the managed CLI', async (t) => {
  const fixture = await createLifecycleFixture(t, '0.1.0');
  assert.equal((await invokeLifecycle(t, fixture, { acceptLicense: true, version: '0.1.0' })).exitCode, 0);
  const profileBeforeUpgrade = await treeManifest(fixture.profileRoot);
  const storageBeforeUpgrade = await hashTree(fixture.storageRoot);
  await replaceRelease(t, fixture, '0.2.0');
  await updateControl(fixture, { failStage: 'after-profile' });
  const result = await invokeLifecycle(t, fixture, { acceptLicense: true, version: '0.2.0' });

  assert.notEqual(result.exitCode, 0);
  await assertInstalledState(fixture, '0.1.0');
  assert.deepEqual(await treeManifest(fixture.profileRoot), profileBeforeUpgrade);
  assert.equal(await hashTree(fixture.storageRoot), storageBeforeUpgrade);
  assert.deepEqual((await readCalls(fixture.callLog)).slice(-2), ['add', 'validate']);
  assert.match(result.stderr, /installation_failed_rolled_back/);
});

test('rollback verification failure reports rollback_incomplete and preserves backup and diagnostic log', async (t) => {
  const fixture = await createLifecycleFixture(t, '0.1.0');
  await updateControl(fixture, { failStage: 'after-profile', rollbackFailure: true });
  const result = await invokeLifecycle(t, fixture, { acceptLicense: true, version: '0.1.0' });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /rollback_incomplete/);
  assert.equal((await findFiles(path.join(fixture.dshHome, 'backups'), 'backup-manifest.json')).length, 1);
  const logPath = operationLogPath(result.stdout);
  assert.match(await readFile(logPath, 'utf8'), /"rollbackResult":"incomplete"/);
});

test('installer temp cleanup failure rolls back, logs a fixed category, and cannot report success', async (t) => {
  const fixture = await createLifecycleFixture(t, '0.1.0');
  const profileBefore = await treeManifest(fixture.profileRoot);
  await updateControl(fixture, { lockInstallerTemp: true });
  const result = await invokeLifecycle(t, fixture, { acceptLicense: true, version: '0.1.0' });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /temporary_cleanup_failed_rolled_back/);
  assert.deepEqual(await treeManifest(fixture.profileRoot), profileBefore);
  assert.match(await readFile(operationLogPath(result.stdout), 'utf8'), /"errorCategory":"temporary-cleanup"/);
  assert.ok((await readdir(path.join(fixture.root, 'installer-temp'))).length >= 1);
});

test('uninstall removes only the managed dependency and bundle while retaining all storage and unrelated bytes', async (t) => {
  const fixture = await createLifecycleFixture(t, '0.1.0');
  const unrelated = await seedUnrelatedProfileFiles(fixture);
  assert.equal((await invokeLifecycle(t, fixture, { acceptLicense: true, version: '0.1.0' })).exitCode, 0);
  const storageBefore = await hashTree(fixture.storageRoot);
  const result = await invokeLifecycle(t, fixture, { acceptLicense: true, operation: 'Uninstall', version: '0.1.0' });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /storage_retained/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(escapeRegExp(fixture.storageRoot), 'i'));
  assert.match(result.stdout, /driveRoot=[A-Z]:\\/);
  const profile = JSON.parse(await readFile(fixture.profilePackagePath, 'utf8')) as {
    bundles: string[];
    credentials: { token: string };
    dependencies: Record<string, string>;
  };
  assert.deepEqual(profile.dependencies, { unrelated: '9.9.9' });
  assert.deepEqual(profile.bundles, ['unrelated-bundle']);
  assert.equal(profile.credentials.token, 'credential-secret-123');
  assert.equal(await hashTree(fixture.storageRoot), storageBefore);
  await assertUnrelatedProfileFiles(unrelated);
  assert.equal((await findFiles(fixture.profileRoot, '.dsh-market-intelligence-receipt.json')).length, 0);
  assert.equal((await findFiles(fixture.profileRoot, 'dsh-market-intelligence-0.1.0.tgz')).length, 0);
  assert.equal((await findFiles(path.join(fixture.dshHome, 'backups'), 'backup-manifest.json')).length, 2);
  assert.deepEqual((await readCalls(fixture.callLog)).slice(-3), ['identity', 'capability', 'remove']);
  const log = await readFile(operationLogPath(result.stdout), 'utf8');
  assert.doesNotMatch(log, /credential-secret-123|cookie-secret-456|sh600000|12\.34/);
});

test('uninstall receipt or cache residual triggers exact rollback instead of success', async (t) => {
  for (const uninstallResidual of ['receipt', 'cache']) {
    await t.test(uninstallResidual, async (child) => {
      const fixture = await createLifecycleFixture(child, '0.1.0');
      assert.equal((await invokeLifecycle(child, fixture, { acceptLicense: true, version: '0.1.0' })).exitCode, 0);
      const profileBefore = await treeManifest(fixture.profileRoot);
      await updateControl(fixture, { uninstallResidual });
      const result = await invokeLifecycle(child, fixture, { acceptLicense: true, operation: 'Uninstall', version: '0.1.0' });

      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr, /uninstall_failed_rolled_back/);
      assert.deepEqual(await treeManifest(fixture.profileRoot), profileBefore);
    });
  }
});

test('already-uninstalled and uninstall WhatIf output only fixed events and drive root', async (t) => {
  const alreadyFixture = await createLifecycleFixture(t, '0.1.0');
  const already = await invokeLifecycle(t, alreadyFixture, { acceptLicense: true, operation: 'Uninstall', version: '0.1.0' });
  assert.equal(already.exitCode, 0, already.stderr || already.stdout);
  assert.doesNotMatch(`${already.stdout}\n${already.stderr}`, new RegExp(escapeRegExp(alreadyFixture.storageRoot), 'i'));
  assert.match(already.stdout, /installer_event=already_uninstalled driveRoot=[A-Z]:\\/);

  const whatIfFixture = await createLifecycleFixture(t, '0.1.0');
  assert.equal((await invokeLifecycle(t, whatIfFixture, { acceptLicense: true, version: '0.1.0' })).exitCode, 0);
  const whatIf = await invokeLifecycle(t, whatIfFixture, { acceptLicense: true, operation: 'Uninstall', version: '0.1.0', whatIf: true });
  assert.equal(whatIf.exitCode, 0, whatIf.stderr || whatIf.stdout);
  assert.doesNotMatch(`${whatIf.stdout}\n${whatIf.stderr}`, new RegExp(escapeRegExp(whatIfFixture.storageRoot), 'i'));
  assert.match(whatIf.stdout, /installer_event=plan_uninstall driveRoot=[A-Z]:\\/);
});

test('real installer entrypoint emits one fixed error line without rejected values, paths, or source positions', async (t) => {
  const rejected = `1.0.0-invalid-${Date.now()}-credential-secret-123`;
  const result = await runInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Continue'",
    '& ([string]$env:DSH_INSTALLER_SCRIPT) -Version ([string]$env:DSH_REJECTED_VALUE) -AcceptLicense',
    'exit $LASTEXITCODE',
  ].join('\n'), { environment: { DSH_REJECTED_VALUE: rejected } });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stdout, /^installer_log=.*installer\.log\r?\n$/i);
  assert.match(result.stderr.trim(), /^installer_failed errorCategory=input$/);
  assert.doesNotMatch(result.stderr, new RegExp(escapeRegExp(rejected), 'i'));
  assert.doesNotMatch(result.stderr, /install\.ps1|runner\.ps1|CategoryInfo|FullyQualifiedErrorId|line|位置/i);
});

test('uninstall WhatIf performs no profile, backup, storage, or mutating CLI write', async (t) => {
  const fixture = await createLifecycleFixture(t, '0.1.0');
  assert.equal((await invokeLifecycle(t, fixture, { acceptLicense: true, version: '0.1.0' })).exitCode, 0);
  const homeBefore = await hashTree(fixture.dshHome);
  const callsBefore = (await readCalls(fixture.callLog)).length;
  const result = await invokeLifecycle(t, fixture, { acceptLicense: true, operation: 'Uninstall', version: '0.1.0', whatIf: true });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /plan_uninstall/);
  assert.equal(await hashTree(fixture.dshHome), homeBefore);
  assert.deepEqual((await readCalls(fixture.callLog)).slice(callsBefore), ['identity', 'capability']);
});

test('post-remove validation failure rolls uninstall back to the exact installed profile and exits nonzero', async (t) => {
  const fixture = await createLifecycleFixture(t, '0.1.0');
  assert.equal((await invokeLifecycle(t, fixture, { acceptLicense: true, version: '0.1.0' })).exitCode, 0);
  const profileBefore = await treeManifest(fixture.profileRoot);
  const storageBefore = await hashTree(fixture.storageRoot);
  await updateControl(fixture, { failStage: 'remove-postcondition' });
  const result = await invokeLifecycle(t, fixture, { acceptLicense: true, operation: 'Uninstall', version: '0.1.0' });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /uninstall_failed_rolled_back/);
  await assertInstalledState(fixture, '0.1.0');
  assert.deepEqual(await treeManifest(fixture.profileRoot), profileBefore);
  assert.equal(await hashTree(fixture.storageRoot), storageBefore);
  assert.deepEqual((await readCalls(fixture.callLog)).slice(-2), ['add', 'validate']);
});

interface LifecycleFixture {
  callLog: string;
  controlPath: string;
  dshHome: string;
  profilePackagePath: string;
  profileRoot: string;
  root: string;
  server: ReleaseFixture;
  storageRoot: string;
}

interface LifecycleFixtureOptions {
  manifestHash?: string;
  packageName?: string;
  packageVariant?: PackageVariant;
}

type PackageVariant = 'normal' | 'bad-license' | 'bad-patch' | 'empty-main' | 'traversal' | 'symlink' | 'hardlink' | 'reserved-device';

async function createLifecycleFixture(t: TestContext, version: string, options: LifecycleFixtureOptions = {}): Promise<LifecycleFixture> {
  const root = await mkdtemp(path.join(process.cwd(), '.tmp-lifecycle-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const dshHome = path.join(root, 'dsh-home');
  const profileRoot = path.join(dshHome, 'profiles', 'desktop');
  const storageRoot = path.join(dshHome, 'storages', 'dsh-market-intelligence');
  await mkdir(profileRoot, { recursive: true });
  await mkdir(storageRoot, { recursive: true });
  await mkdir(path.join(root, 'installer-temp'), { recursive: true });
  const profilePackagePath = path.join(profileRoot, 'package.json');
  await writeFile(profilePackagePath, JSON.stringify({
    bundles: ['unrelated-bundle'],
    credentials: { token: 'credential-secret-123' },
    dependencies: { unrelated: '9.9.9' },
  }, null, 2), 'utf8');
  await writeFile(path.join(profileRoot, 'pnpm-lock.yaml'), 'fixtureLock: true\nunrelated: 9.9.9\n', 'utf8');
  await writeFile(path.join(profileRoot, 'cordis.patch.yml'), 'fixturePatch: true\nunrelatedBundle: true\n', 'utf8');
  await writeFile(path.join(storageRoot, 'credentials.json'), '{"cookie":"cookie-secret-456"}', 'utf8');
  await writeFile(path.join(storageRoot, 'watchlist.json'), '["sh600000"]', 'utf8');
  await writeFile(path.join(storageRoot, 'market-row.json'), '{"symbol":"sh600000","price":12.34}', 'utf8');

  const server = await createRelease(root, version, options);
  t.after(async () => { await server.close(); });

  const callLog = path.join(root, 'fake-dsh-calls.log');
  const controlPath = path.join(root, 'fake-dsh-control.json');
  await writeFile(controlPath, JSON.stringify({ callLog, dshHome, failStage: '' }), 'utf8');
  return { callLog, controlPath, dshHome, profilePackagePath, profileRoot, root, server, storageRoot };
}

async function createRelease(root: string, version: string, options: LifecycleFixtureOptions = {}): Promise<ReleaseFixture> {
  const tgzName = `dsh-market-intelligence-${version}.tgz`;
  const tgz = await createPackage(root, version, tgzName, options.packageName, options.packageVariant ?? 'normal');
  const manifest = Buffer.from(`${options.manifestHash ?? sha256(tgz)}  ${tgzName}\n`, 'utf8');
  return startReleaseServer({ assets: { 'SHA256SUMS.txt': manifest, [tgzName]: tgz }, tagName: `v${version}` });
}

async function createPackage(
  root: string,
  version: string,
  tgzName: string,
  packageName = 'dsh-market-intelligence',
  variant: PackageVariant = 'normal',
): Promise<Buffer> {
  const metadata = Buffer.from(JSON.stringify({
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    license: 'SEE LICENSE IN LICENSE',
    main: './lib/index.js',
    name: packageName,
    version,
  }), 'utf8');
  const main = Buffer.from(variant === 'empty-main' ? '' : 'export const fixture = true;\n', 'utf8');
  const approvedPatch = await readFile(path.join(process.cwd(), 'cordis.patch.yml'));
  const approvedLicense = await readFile(path.join(process.cwd(), 'LICENSE'));
  const patch = variant === 'bad-patch' ? Buffer.from('insert:\n  - path: C:\\Users\\victim\n', 'utf8') : approvedPatch;
  const license = variant === 'bad-license' ? Buffer.from('not the approved license\n', 'utf8') : approvedLicense;

  if (variant === 'traversal' || variant === 'symlink' || variant === 'hardlink' || variant === 'reserved-device') {
    const entries: RawTarEntry[] = [
      { name: 'package/package.json', content: metadata, type: '0' },
      { name: 'package/lib/index.js', content: main, type: '0' },
      { name: 'package/cordis.patch.yml', content: patch, type: '0' },
      { name: 'package/LICENSE', content: license, type: '0' },
    ];
    if (variant === 'traversal') entries.push({ name: '../escape.txt', content: Buffer.from('escape'), type: '0' });
    if (variant === 'symlink') entries.push({ name: 'package/link', content: Buffer.alloc(0), type: '2', linkName: '../outside' });
    if (variant === 'hardlink') entries.push({ name: 'package/hard', content: Buffer.alloc(0), type: '1', linkName: 'package/LICENSE' });
    if (variant === 'reserved-device') entries.push({ name: 'package/lib/COM1.js', content: Buffer.from('reserved'), type: '0' });
    return createRawTarGz(entries);
  }

  const packageParent = path.join(root, `package-source-${version}`);
  const packageRoot = path.join(packageParent, 'package');
  await mkdir(path.join(packageRoot, 'lib'), { recursive: true });
  await writeFile(path.join(packageRoot, 'package.json'), metadata);
  await writeFile(path.join(packageRoot, 'lib', 'index.js'), main);
  await writeFile(path.join(packageRoot, 'cordis.patch.yml'), patch);
  await writeFile(path.join(packageRoot, 'LICENSE'), license);
  const tgzPath = path.join(root, tgzName);
  await execFileAsync('tar.exe', ['-czf', tgzPath, '-C', packageParent, 'package'], { windowsHide: true });
  return readFile(tgzPath);
}

interface RawTarEntry {
  content: Buffer;
  linkName?: string;
  name: string;
  type: '0' | '1' | '2';
}

function createRawTarGz(entries: RawTarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512, 0);
    writeTarString(header, entry.name, 0, 100);
    writeTarOctal(header, 0o644, 100, 8);
    writeTarOctal(header, 0, 108, 8);
    writeTarOctal(header, 0, 116, 8);
    writeTarOctal(header, entry.type === '0' ? entry.content.length : 0, 124, 12);
    writeTarOctal(header, 0, 136, 12);
    header.fill(0x20, 148, 156);
    header.write(entry.type, 156, 1, 'ascii');
    if (entry.linkName !== undefined) writeTarString(header, entry.linkName, 157, 100);
    writeTarString(header, 'ustar', 257, 6);
    writeTarString(header, '00', 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    const encodedChecksum = checksum.toString(8).padStart(6, '0');
    header.write(encodedChecksum, 148, 6, 'ascii');
    header[154] = 0;
    header[155] = 0x20;
    blocks.push(header);
    if (entry.type === '0') {
      blocks.push(entry.content);
      const padding = (512 - (entry.content.length % 512)) % 512;
      if (padding > 0) blocks.push(Buffer.alloc(padding, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(blocks));
}

function writeTarString(buffer: Buffer, value: string, offset: number, length: number): void {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length > length) throw new Error('raw tar test entry field is too long');
  encoded.copy(buffer, offset);
}

function writeTarOctal(buffer: Buffer, value: number, offset: number, length: number): void {
  const encoded = value.toString(8).padStart(length - 1, '0');
  buffer.write(encoded, offset, length - 1, 'ascii');
  buffer[offset + length - 1] = 0;
}

async function invokeLifecycle(
  t: TestContext,
  fixture: LifecycleFixture,
  options: { acceptLicense?: boolean; allowDowngrade?: boolean; failCleanup?: boolean; operation?: 'Install' | 'Uninstall'; processOwned?: boolean; version?: string; whatIf?: boolean },
) {
  return runInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Continue'",
    '. ([string]$env:DSH_INSTALLER_SCRIPT)',
    'if ($env:DSH_FAIL_CLEANUP -eq "1") {',
    '  function Remove-InstallerTemporaryDirectory {',
    '    [CmdletBinding()] param([Parameter(Mandatory = $true)][object]$OwnedDirectory, [scriptblock]$AfterEnumeration, [int]$FailDispositionAt = 0)',
    '    [System.IO.File]::AppendAllText([string]$env:DSH_CLEANUP_ATTEMPTS, "attempt`n")',
    '    try { [DshMarketInstaller.InstallerCapabilities]::CleanupTemporary($OwnedDirectory, $null, 1) | Out-Null } catch {}',
    '    throw "temporary_cleanup_failed"',
    '  }',
    '}',
    '$driveIds = @([System.IO.Path]::GetPathRoot([string]$env:DSH_FIXTURE_HOME).TrimEnd("\\"), [System.IO.Path]::GetPathRoot([System.IO.Path]::GetTempPath()).TrimEnd("\\")) | Sort-Object -Unique',
    '$driveRecords = @($driveIds | ForEach-Object { [pscustomobject]@{ DeviceID = $_; DriveType = 3 } })',
    '$installerArguments = @{ DshHome = [string]$env:DSH_FIXTURE_HOME; DshCommand = [string]$env:DSH_FAKE_DSH; ReleaseApiUri = [uri]$env:DSH_RELEASE_API; DriveRecords = $driveRecords; ProcessRecords = @() }',
    'if ($env:DSH_REQUESTED_VERSION) { $installerArguments.Version = [string]$env:DSH_REQUESTED_VERSION }',
    'if ($env:DSH_ACCEPT_LICENSE -eq "1") { $installerArguments.AcceptLicense = $true }',
    'if ($env:DSH_ALLOW_DOWNGRADE -eq "1") { $installerArguments.AllowDowngrade = $true }',
    'if ($env:DSH_OPERATION) { $installerArguments.Operation = [string]$env:DSH_OPERATION }',
    'if ($env:DSH_WHAT_IF -eq "1") { $installerArguments.WhatIf = $true }',
    'if ($env:DSH_PROCESS_OWNED -eq "1") { $installerArguments.ProcessRecords = @([pscustomobject]@{ ProcessId = 4242; ExecutablePath = [string]$env:DSH_FAKE_DSH; CommandLine = "" }) }',
    '$env:DSH_HOME = [string]$env:DSH_PARENT_HOME',
    'Invoke-DshMarketInstall @installerArguments',
    '$installerSucceeded = $?',
    'if (-not [string]::Equals([string]$env:DSH_HOME, [string]$env:DSH_PARENT_HOME, [System.StringComparison]::Ordinal)) { throw "parent_home_not_restored" }',
    'if (-not $installerSucceeded) { exit 1 }',
    'exit 0',
  ].join('\n'), {
    environment: {
      DSH_FAKE_CONTROL: fixture.controlPath,
      DSH_FAKE_DSH: fakeDshPath,
      DSH_FIXTURE_HOME: fixture.dshHome,
      DSH_RELEASE_API: fixture.server.apiUrl,
      DSH_REQUESTED_VERSION: options.version ?? '',
      DSH_ACCEPT_LICENSE: options.acceptLicense ? '1' : '0',
      DSH_ALLOW_DOWNGRADE: options.allowDowngrade ? '1' : '0',
      DSH_OPERATION: options.operation ?? 'Install',
      DSH_WHAT_IF: options.whatIf ? '1' : '0',
      DSH_PROCESS_OWNED: options.processOwned ? '1' : '0',
      DSH_FAIL_CLEANUP: options.failCleanup ? '1' : '0',
      DSH_CLEANUP_ATTEMPTS: path.join(fixture.root, 'cleanup-attempts.log'),
      DSH_PARENT_HOME: path.join(fixture.root, 'parent-home-sentinel'),
      TEMP: path.join(fixture.root, 'installer-temp'),
      TMP: path.join(fixture.root, 'installer-temp'),
    },
  });
}

async function replaceRelease(t: TestContext, fixture: LifecycleFixture, version: string): Promise<void> {
  await fixture.server.close();
  fixture.server = await createRelease(fixture.root, version);
  t.after(async () => { await fixture.server.close(); });
}

async function updateControl(fixture: LifecycleFixture, values: Record<string, unknown>): Promise<void> {
  const current = JSON.parse(await readFile(fixture.controlPath, 'utf8')) as Record<string, unknown>;
  await writeFile(fixture.controlPath, JSON.stringify({ ...current, ...values }), 'utf8');
}

async function assertInstalledState(fixture: LifecycleFixture, version: string): Promise<void> {
  const profile = JSON.parse(await readFile(fixture.profilePackagePath, 'utf8')) as {
    bundles: string[];
    credentials: { token: string };
    dependencies: Record<string, string>;
  };
  assert.equal(profile.dependencies.unrelated, '9.9.9');
  assert.equal(profile.dependencies['dsh-market-intelligence'], version);
  assert.deepEqual(profile.bundles, ['unrelated-bundle', 'dsh-market-intelligence']);
  assert.equal(profile.credentials.token, 'credential-secret-123');
}

interface UnrelatedProfileFiles {
  cache: { content: Buffer; path: string };
  coordination: { content: Buffer; path: string };
  module: { content: Buffer; path: string };
}

async function seedUnrelatedProfileFiles(fixture: LifecycleFixture): Promise<UnrelatedProfileFiles> {
  const files: UnrelatedProfileFiles = {
    cache: { path: path.join(fixture.profileRoot, '.dsh-market-cache', 'unrelated-cache.tgz'), content: Buffer.from('unrelated-cache-secret') },
    coordination: { path: path.join(fixture.profileRoot, 'coordination-extra.json'), content: Buffer.from('{"unrelated":true}') },
    module: { path: path.join(fixture.profileRoot, 'node_modules', 'unrelated-package', 'index.js'), content: Buffer.from('export const unrelated = true;\n') },
  };
  for (const file of Object.values(files)) {
    await mkdir(path.dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content);
  }
  return files;
}

async function assertUnrelatedProfileFiles(files: UnrelatedProfileFiles): Promise<void> {
  for (const file of Object.values(files)) assert.deepEqual(await readFile(file.path), file.content);
}

async function readCalls(callLog: string): Promise<string[]> {
  try {
    return (await readFile(callLog, 'utf8')).split(/\r?\n/).filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function operationLogPath(stdout: string): string {
  const match = /^installer_log=(.+\\installer\.log)$/im.exec(stdout);
  assert.ok(match, `missing operation log path in output: ${stdout}`);
  return match[1].trim();
}

async function hashTree(root: string): Promise<string> {
  const hash = createHash('sha256');
  for (const entry of await listTreeEntries(root)) {
    hash.update(entry.type);
    hash.update('\0');
    hash.update(entry.relative.replaceAll('\\', '/'));
    hash.update('\0');
    if (entry.type === 'file') hash.update(await readFile(path.join(root, entry.relative)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function listTreeEntries(root: string, relative = ''): Promise<Array<{ relative: string; type: 'directory' | 'file' }>> {
  const current = path.join(root, relative);
  const entries = await readdir(current, { withFileTypes: true });
  const result: Array<{ relative: string; type: 'directory' | 'file' }> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      result.push({ relative: child, type: 'directory' });
      result.push(...await listTreeEntries(root, child));
    } else if (entry.isFile()) result.push({ relative: child, type: 'file' });
  }
  return result;
}

async function treeManifest(root: string): Promise<Array<{ file: string; length: number; sha256: string }>> {
  const result: Array<{ file: string; length: number; sha256: string }> = [];
  for (const file of await listFiles(root)) {
    const content = await readFile(path.join(root, file));
    result.push({ file: file.replaceAll('\\', '/'), length: content.length, sha256: sha256(content) });
  }
  return result;
}

async function listFiles(root: string, relative = ''): Promise<string[]> {
  const current = path.join(root, relative);
  const entries = await readdir(current, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(root, child));
    else if (entry.isFile()) result.push(child);
  }
  return result;
}

async function findFiles(root: string, basename: string): Promise<string[]> {
  try {
    await stat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return (await listFiles(root)).filter((file) => path.basename(file) === basename).map((file) => path.join(root, file));
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
