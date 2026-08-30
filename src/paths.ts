import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

const WINDOWS_DRIVE_ROOT = /^[A-Za-z]:\\$/;
const DRIVE_TYPE_SCRIPT = [
  "$driveRoot = $env:DSH_MARKET_DRIVE_ROOT",
  "$deviceId = $driveRoot.TrimEnd('\\')",
  "$disk = Get-CimInstance -ClassName Win32_LogicalDisk -Filter \"DeviceID='$deviceId'\"",
  'if ($null -eq $disk) { exit 1 }',
  '[Console]::Out.Write([string][int]$disk.DriveType)',
].join('; ');

export function requireLocalWindowsPath(value: unknown, label: string, requiredBasename?: string): string {
  if (typeof value !== 'string'
    || !path.win32.isAbsolute(value)
    || !WINDOWS_DRIVE_ROOT.test(path.win32.parse(value).root)
    || path.win32.normalize(value) !== value) {
    throw new Error(`${label} must be a normalized absolute local Windows path`);
  }
  if (requiredBasename !== undefined && path.win32.basename(value).toLowerCase() !== requiredBasename.toLowerCase()) {
    throw new Error(`${label} must use ${requiredBasename} as its final directory`);
  }
  return value;
}

export async function getWindowsDriveType(driveRoot: string, execFileImpl: typeof execFile = execFile): Promise<number> {
  if (!WINDOWS_DRIVE_ROOT.test(driveRoot)) throw new Error('drive root must be a validated local Windows drive root');
  const output = await new Promise<string>((resolve, reject) => {
    execFileImpl(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', DRIVE_TYPE_SCRIPT],
      { env: { ...process.env, DSH_MARKET_DRIVE_ROOT: driveRoot } },
      (error, stdout) => error === null ? resolve(String(stdout)) : reject(error),
    );
  });
  const trimmedOutput = output.trim();
  if (!/^\d+$/.test(trimmedOutput)) throw new Error('unable to determine Windows drive type');
  const driveType = Number(trimmedOutput);
  if (!Number.isInteger(driveType)) throw new Error('unable to determine Windows drive type');
  return driveType;
}

export async function assertSafeLocalWindowsPath(
  pathValue: string,
  dependencies: {
    lstatImpl?: typeof lstat;
    getDriveTypeImpl?: typeof getWindowsDriveType;
  } = {},
): Promise<void> {
  const localPath = requireLocalWindowsPath(pathValue, 'path');
  const driveRoot = path.win32.parse(localPath).root;
  const getDriveTypeImpl = dependencies.getDriveTypeImpl ?? getWindowsDriveType;
  if (await getDriveTypeImpl(driveRoot) !== 3) throw new Error(`${localPath} must be on a local fixed Windows drive`);

  const lstatImpl = dependencies.lstatImpl ?? lstat;
  for (let current = localPath; ; current = path.win32.dirname(current)) {
    try {
      const stats = await lstatImpl(current);
      if (stats.isSymbolicLink()) throw new Error(`${localPath} must not traverse a reparse point`);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }
    if (current === driveRoot) return;
  }
}

function isMissingPath(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
