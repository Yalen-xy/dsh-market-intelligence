import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TestContext } from 'node:test';

export interface PowerShellResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export class PowerShellInvocationError extends Error {
  readonly result: PowerShellResult;

  constructor(result: PowerShellResult) {
    super(`PowerShell exited with code ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`);
    this.name = 'PowerShellInvocationError';
    this.result = result;
  }
}

export async function runInstallerPowerShell(
  t: TestContext,
  source: string,
  options: {
    environment?: Record<string, string>;
    input?: unknown;
    timeoutMs?: number;
  } = {},
): Promise<PowerShellResult> {
  const root = await mkdtemp(path.join(process.cwd(), '.tmp-installer-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });

  const runnerPath = path.join(root, 'runner.ps1');
  const inputPath = path.join(root, 'input.json');
  await writeFile(runnerPath, source, 'utf8');
  await writeFile(inputPath, JSON.stringify(options.input ?? null), 'utf8');

  const shell = process.env.DSH_INSTALLER_TEST_SHELL || 'powershell.exe';
  const result = await new Promise<PowerShellResult>((resolve) => {
    execFile(
      shell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runnerPath],
      {
        cwd: root,
        env: {
          ...process.env,
          DSH_INSTALLER_TEST_INPUT: inputPath,
          DSH_INSTALLER_TEST_ROOT: root,
          DSH_INSTALLER_SCRIPT: path.join(process.cwd(), 'installer', 'install.ps1'),
          DSH_UNINSTALLER_SCRIPT: path.join(process.cwd(), 'installer', 'uninstall.ps1'),
          ...options.environment,
        },
        windowsHide: true,
        timeout: options.timeoutMs ?? 30_000,
        killSignal: 'SIGKILL',
      },
      (error, stdout, stderr) => {
        const exitCode = typeof error?.code === 'number' ? error.code : error === null ? 0 : 1;
        resolve({ exitCode, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
  return result;
}

export async function runInteractiveInstallerPowerShell(
  t: TestContext,
  arguments_: string[],
  options: {
    environment?: Record<string, string>;
    scriptPath?: string;
    stdin?: string | null;
    timeoutMs?: number;
  } = {},
): Promise<PowerShellResult> {
  const shell = process.env.DSH_INSTALLER_TEST_SHELL || 'powershell.exe';
  return new Promise<PowerShellResult>((resolve) => {
    const child = spawn(
      shell,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', options.scriptPath ?? path.join(process.cwd(), 'installer', 'install.ps1'), ...arguments_],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...options.environment },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 30_000);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stderr, stdout });
    });
    child.stdin.end(options.stdin ?? undefined);
  });
}

export async function invokeInstallerPowerShell(
  t: TestContext,
  source: string,
  input?: unknown,
  environment?: Record<string, string>,
): Promise<string> {
  const result = await runInstallerPowerShell(t, source, { input, environment });
  if (result.exitCode !== 0) throw new PowerShellInvocationError(result);
  return result.stdout.trim();
}

export function parseJsonOutput<T>(output: string): T {
  return JSON.parse(output.replace(/^\uFEFF/, '')) as T;
}
