import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function runInstallerTests(shell, dependencies = {}) {
  if (typeof shell !== 'string' || shell.length === 0) {
    return Promise.reject(new Error('installer test shell is required'));
  }
  const spawnImpl = dependencies.spawnImpl ?? spawn;
  return new Promise((resolve, reject) => {
    const child = spawnImpl(
      process.execPath,
      ['--import', 'tsx', '--test', 'test/installer-*.test.ts'],
      {
        stdio: 'inherit',
        env: { ...process.env, DSH_INSTALLER_TEST_SHELL: shell },
      },
    );
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runInstallerTests(process.argv[2]).then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error(error instanceof Error ? error.message : 'installer test launcher failed');
      process.exitCode = 1;
    },
  );
}
