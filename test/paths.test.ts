import assert from 'node:assert/strict';
import type { execFile } from 'node:child_process';
import { test } from 'node:test';
import { assertSafeLocalWindowsPath, getWindowsDriveType, requireLocalWindowsPath } from '../src/paths.ts';

test('accepts normalized absolute paths on any Windows drive', () => {
  for (const value of [
    'C:\\Users\\张三\\.dsh',
    'D:\\AI\\dsh',
    'Z:\\Research Data\\dsh-market-intelligence',
  ]) assert.equal(requireLocalWindowsPath(value, 'path'), value);
});

test('rejects non-local, non-normalized, and relative path forms', () => {
  for (const value of [
    '.\\dsh',
    '\\\\server\\share\\dsh',
    '\\\\?\\C:\\dsh',
    'C:\\safe\\..\\escape',
    'C:/mixed/separators',
  ]) assert.throws(() => requireLocalWindowsPath(value, 'path'), /local Windows path/i);
});

test('requires the explicit storage root basename', () => {
  assert.equal(
    requireLocalWindowsPath('E:\\Market\\dsh-market-intelligence', 'storageDir', 'dsh-market-intelligence'),
    'E:\\Market\\dsh-market-intelligence',
  );
  assert.throws(
    () => requireLocalWindowsPath('E:\\Market\\other', 'storageDir', 'dsh-market-intelligence'),
    /final directory/i,
  );
});

test('accepts a fixed drive after checking existing ancestors through a not-yet-created suffix', async () => {
  const inspected: string[] = [];
  await assertSafeLocalWindowsPath('Z:\\Research\\new\\dsh-market-intelligence', {
    getDriveTypeImpl: async (driveRoot) => {
      assert.equal(driveRoot, 'Z:\\');
      return 3;
    },
    lstatImpl: async (current) => {
      inspected.push(current);
      const error = Object.assign(new Error('missing'), { code: 'ENOENT' });
      throw error;
    },
  });
  assert.deepEqual(inspected, [
    'Z:\\Research\\new\\dsh-market-intelligence',
    'Z:\\Research\\new',
    'Z:\\Research',
    'Z:\\',
  ]);
});

test('rejects removable, network, and optical Windows drives', async () => {
  for (const driveType of [2, 4, 5]) {
    await assert.rejects(
      assertSafeLocalWindowsPath('C:\\runtime\\dsh-market-intelligence', {
        getDriveTypeImpl: async () => driveType,
        lstatImpl: async () => { throw new Error('must not inspect an unsafe drive'); },
      }),
      /local fixed Windows drive/i,
    );
  }
});

test('rejects a symbolic-link ancestor before creating the storage root', async () => {
  await assert.rejects(
    assertSafeLocalWindowsPath('D:\\safe\\linked\\dsh-market-intelligence', {
      getDriveTypeImpl: async () => 3,
      lstatImpl: async (current) => {
        if (current === 'D:\\safe\\linked') return { isSymbolicLink: () => true } as never;
        const error = Object.assign(new Error('missing'), { code: 'ENOENT' });
        throw error;
      },
    }),
    /reparse point/i,
  );
});

test('requires a non-empty integer drive type from PowerShell', async () => {
  await assert.rejects(getWindowsDriveType('C:\\', execFileWithOutput('')), /unable to determine/i);
  await assert.rejects(getWindowsDriveType('C:\\', execFileWithOutput('3.0')), /unable to determine/i);
  assert.equal(await getWindowsDriveType('C:\\', execFileWithOutput('3')), 3);
});

function execFileWithOutput(output: string): typeof execFile {
  return ((file: string, args: readonly string[], options: unknown, callback: (error: Error | null, stdout: string) => void) => {
    assert.equal(file, 'powershell.exe');
    assert.deepEqual(args, [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      [
        "$driveRoot = $env:DSH_MARKET_DRIVE_ROOT",
        "$deviceId = $driveRoot.TrimEnd('\\')",
        "$disk = Get-CimInstance -ClassName Win32_LogicalDisk -Filter \"DeviceID='$deviceId'\"",
        'if ($null -eq $disk) { exit 1 }',
        '[Console]::Out.Write([string][int]$disk.DriveType)',
      ].join('; '),
    ]);
    assert.deepEqual(options, { env: { ...process.env, DSH_MARKET_DRIVE_ROOT: 'C:\\' } });
    callback(null, output);
    return {} as never;
  }) as typeof execFile;
}
