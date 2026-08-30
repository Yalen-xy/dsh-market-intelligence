import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants,
  copyFile,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageName = 'dsh-market-intelligence';
const semanticVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const requiredPackageEntries = [
  'package/package.json',
  'package/lib/index.js',
  'package/cordis.patch.yml',
  'package/LICENSE',
];

export async function stageRelease({ tag, packagePath, outputDirectory, rootDirectory = projectRoot() }) {
  const version = parseStableTag(tag);
  const sourcePackage = path.resolve(packagePath);
  const requestedOutput = path.resolve(outputDirectory);
  const root = path.resolve(rootDirectory);
  const sourceAssets = [
    { source: sourcePackage, destination: `${packageName}-${version}.tgz` },
    { source: path.join(root, 'installer', 'install.ps1'), destination: 'install.ps1' },
    { source: path.join(root, 'installer', 'uninstall.ps1'), destination: 'uninstall.ps1' },
    { source: path.join(root, 'LICENSE'), destination: 'LICENSE.txt' },
  ];
  await assertFilesExist(sourceAssets.slice(1));
  assertOutputDoesNotOverlapSources(requestedOutput, sourceAssets);
  const output = await resolveOutputPath(requestedOutput);
  await assertOutputTargetAbsent(output);
  try {
    const temporaryOutput = await mkdtemp(path.join(path.dirname(output), '.stage-release-'));
    const stagedPackage = path.join(temporaryOutput, sourceAssets[0].destination);
    for (const asset of sourceAssets) {
      await copyFile(asset.source, path.join(temporaryOutput, asset.destination), constants.COPYFILE_EXCL);
    }
    const metadata = await readPackageMetadata(stagedPackage);
    validatePackageMetadata(metadata, version);
    const manifest = await createManifest(temporaryOutput, sourceAssets.map((asset) => asset.destination));
    await writeFile(path.join(temporaryOutput, 'SHA256SUMS.txt'), manifest, { flag: 'wx' });
    await verifyStagedAssets(temporaryOutput, sourceAssets.map((asset) => asset.destination), manifest);
    await assertOutputTargetAbsent(output);
    await rename(temporaryOutput, output);
  } catch (error) {
    if (isSafeStagedValidationError(error)) throw error;
    throw new Error('release staging failed');
  }
}

function isSafeStagedValidationError(error) {
  return error instanceof Error && /^package (archive|metadata|name|version)/.test(error.message);
}

function projectRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function parseStableTag(tag) {
  if (typeof tag !== 'string') throw new Error('stable release tag is required');
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
  if (match === null) throw new Error('stable release tag must be vMAJOR.MINOR.PATCH');
  return match.slice(1).join('.');
}

async function readPackageMetadata(packagePath) {
  await readArchiveEntries(packagePath);
  let text;
  try {
    const { stdout } = await execFileAsync('tar.exe', ['-xOf', packagePath, 'package/package.json'], {
      encoding: 'buffer',
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    text = Buffer.from(stdout).toString('utf8');
  } catch {
    throw new Error('package metadata could not be read from the archive');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('package metadata is invalid');
  }
}

async function readArchiveEntries(packagePath) {
  let rawEntries;
  let detailLines;
  try {
    const [names, details] = await Promise.all([
      execFileAsync('tar.exe', ['-tf', packagePath], {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      }),
      execFileAsync('tar.exe', ['-tvf', packagePath], {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      }),
    ]);
    rawEntries = String(names.stdout)
      .split(/\r?\n/)
      .filter((entry) => entry.length > 0);
    detailLines = String(details.stdout)
      .split(/\r?\n/)
      .filter((entry) => entry.length > 0);
  } catch {
    throw new Error('package archive could not be inspected');
  }
  if (rawEntries.length !== detailLines.length || detailLines.some((line) => !/^[\-d]/.test(line))) {
    throw new Error('package archive entries invalid');
  }
  return validateArchiveEntries(rawEntries.map((name, index) => ({ name, type: detailLines[index][0] })));
}

function validateArchiveEntries(rawEntries) {
  const entries = [];
  const seen = new Set();
  for (const rawEntry of rawEntries) {
    const entry = canonicalizeArchiveEntry(rawEntry.name, rawEntry.type);
    const key = entry.name.toLowerCase();
    if (seen.has(key)) throw new Error('package archive entries invalid');
    seen.add(key);
    entries.push(entry);
  }
  for (const requiredEntry of requiredPackageEntries) {
    if (entries.filter((entry) => entry.type === '-' && entry.name === requiredEntry).length !== 1) {
      throw new Error('package archive entries invalid');
    }
  }
  return entries;
}

function canonicalizeArchiveEntry(rawEntry, type) {
  if (typeof rawEntry !== 'string' || rawEntry.length === 0 || /[\\\x00-\x1f\x7f]/.test(rawEntry)) {
    throw new Error('package archive entries invalid');
  }
  if (type !== '-' && type !== 'd') throw new Error('package archive entries invalid');
  const hasTrailingSeparator = rawEntry.endsWith('/');
  if ((type === '-' && hasTrailingSeparator) || (type === 'd' && !hasTrailingSeparator)) {
    throw new Error('package archive entries invalid');
  }
  const name = hasTrailingSeparator ? rawEntry.slice(0, -1) : rawEntry;
  if (name.length === 0 || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new Error('package archive entries invalid');
  }
  const segments = name.split('/');
  if (segments.some((segment) => !isSafeArchiveComponent(segment))) {
    throw new Error('package archive entries invalid');
  }
  const canonical = segments.join('/');
  if (rawEntry !== `${canonical}${hasTrailingSeparator ? '/' : ''}`) throw new Error('package archive entries invalid');
  if ((canonical === 'package' && type !== 'd') || (canonical !== 'package' && !canonical.startsWith('package/'))) {
    throw new Error('package archive entries invalid');
  }
  return { name: canonical, type };
}

function isSafeArchiveComponent(component) {
  if (component.length === 0 || component === '.' || component === '..' || /[:*?"<>|]/.test(component) || /[. ]$/.test(component)) {
    return false;
  }
  const stem = component.split('.', 1)[0].toUpperCase();
  return !/^(CON|PRN|AUX|NUL|CLOCK\$|COM[1-9]|LPT[1-9])$/.test(stem);
}

function validatePackageMetadata(metadata, version) {
  if (metadata === null || typeof metadata !== 'object') throw new Error('package metadata is invalid');
  if (metadata.name !== packageName) throw new Error('package name must be dsh-market-intelligence');
  if (metadata.version !== version || !semanticVersionPattern.test(metadata.version)) {
    throw new Error('package version must exactly match the release tag');
  }
  if (metadata.main !== './lib/index.js' || metadata.license !== 'SEE LICENSE IN LICENSE' ||
      metadata.dsh?.bundle?.patch !== './cordis.patch.yml') {
    throw new Error('package metadata is not compatible with the installer');
  }
}

async function assertFilesExist(sourceAssets) {
  for (const asset of sourceAssets) {
    try {
      await readFile(asset.source);
    } catch {
      if (asset.destination === 'LICENSE.txt') throw new Error('license file is required for release staging');
      throw new Error(`required release asset is missing: ${asset.destination}`);
    }
  }
}

async function createManifest(directory, assetNames) {
  const rows = await Promise.all(assetNames.map(async (name) => {
    const bytes = await readFile(path.join(directory, name));
    return { name, hash: createHash('sha256').update(bytes).digest('hex') };
  }));
  return `${rows
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    .map(({ hash, name }) => `${hash}  ${name}`)
    .join('\n')}\n`;
}

async function verifyStagedAssets(directory, assetNames, manifest) {
  const expectedNames = [...assetNames, 'SHA256SUMS.txt'].sort();
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    throw new Error('release staging verification failed');
  }
  const names = entries.map((entry) => entry.name).sort();
  if (entries.some((entry) => !entry.isFile()) || names.length !== expectedNames.length ||
      names.some((name, index) => name !== expectedNames[index])) {
    throw new Error('release staging verification failed');
  }
  const actualManifest = await readFile(path.join(directory, 'SHA256SUMS.txt'), 'utf8');
  if (actualManifest !== manifest || actualManifest !== await createManifest(directory, assetNames)) {
    throw new Error('release staging verification failed');
  }
}

function assertOutputDoesNotOverlapSources(output, sourceAssets) {
  for (const asset of sourceAssets) {
    const source = path.resolve(asset.source);
    if (isSameOrDescendant(output, source) || isSameOrDescendant(source, output)) {
      throw new Error('output overlaps source assets');
    }
  }
}

function isSameOrDescendant(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function resolveOutputPath(requestedOutput) {
  let resolvedParent;
  try {
    resolvedParent = await realpath(path.dirname(requestedOutput));
  } catch {
    throw new Error('output parent is unavailable');
  }
  return path.join(resolvedParent, path.basename(requestedOutput));
}

async function assertOutputTargetAbsent(output) {
  try {
    await lstat(output);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw new Error('output target is unavailable');
  }
  throw new Error('output target must not exist');
}

function parseArguments(argumentsList) {
  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!['--tag', '--package', '--output'].includes(key) || value === undefined || values.has(key)) {
      throw new Error('usage: node scripts/stage-release.mjs --tag vMAJOR.MINOR.PATCH --package <tgz> --output <dir>');
    }
    values.set(key, value);
  }
  if (values.size !== 3) {
    throw new Error('usage: node scripts/stage-release.mjs --tag vMAJOR.MINOR.PATCH --package <tgz> --output <dir>');
  }
  return { tag: values.get('--tag'), packagePath: values.get('--package'), outputDirectory: values.get('--output') };
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  stageRelease(parseArguments(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : 'release staging failed');
    process.exitCode = 1;
  });
}
