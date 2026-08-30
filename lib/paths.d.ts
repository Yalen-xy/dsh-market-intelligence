import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
export declare function requireLocalWindowsPath(value: unknown, label: string, requiredBasename?: string): string;
export declare function getWindowsDriveType(driveRoot: string, execFileImpl?: typeof execFile): Promise<number>;
export declare function assertSafeLocalWindowsPath(pathValue: string, dependencies?: {
    lstatImpl?: typeof lstat;
    getDriveTypeImpl?: typeof getWindowsDriveType;
}): Promise<void>;
