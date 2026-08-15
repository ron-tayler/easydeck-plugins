/**
 * The whole of CI, until there is a CI.
 *
 * Walks `plugins/<author>/<name>/`, bundles each into `build/<id>/` — one
 * `main.mjs` with everything in it — copies the parts the host reads without
 * running anything (icons, locales, assets), writes each plugin's
 * `plugin.json` from the manifest its code exports, and ends with
 * `registry/index.json`: the store's whole view of the world.
 *
 * The manifest is read by *importing the built bundle*, not by parsing the
 * source: what lands in plugin.json is what the code will actually say at
 * load, and a build whose manifest cannot even be imported fails here rather
 * than on somebody's machine.
 *
 * When this repository grows a remote, a workflow runs this same script and
 * attaches zips of `build/<id>` to a release; the index gains URLs next to
 * hashes. The format does not change — see the main repository's
 * docs/plugin-distribution.md.
 */
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import esbuild from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginsRoot = join(root, 'plugins');
const buildRoot = join(root, 'build');
const registryFile = join(root, 'registry', 'index.json');

/** The folders the host reads as data; everything else is source. */
const CARRIED = ['icons', 'locales', 'assets', 'natives'];

async function main() {
  await rm(buildRoot, { recursive: true, force: true });
  const entries = [];

  for (const author of await folders(pluginsRoot)) {
    for (const name of await folders(join(pluginsRoot, author))) {
      const folder = join(pluginsRoot, author, name);
      const entry = await buildOne(author, name, folder);
      entries.push(entry);
      console.log(`built ${entry.id}@${entry.version} (${entry.bytes} bytes)`);
    }
  }

  entries.sort((one, other) => one.id.localeCompare(other.id));

  const duplicates = entries.filter(
    (entry, at) => entries.findIndex((other) => other.id === entry.id) !== at,
  );
  if (duplicates.length > 0) {
    // Two authors may collide out in the world; inside one repository a
    // collision is simply a mistake, and the registry is where it is caught.
    throw new Error(`duplicate plugin id: ${duplicates.map((entry) => entry.id).join(', ')}`);
  }

  await mkdir(dirname(registryFile), { recursive: true });
  await writeFile(
    registryFile,
    JSON.stringify({ generated: new Date().toISOString(), plugins: entries }, null, 2),
    'utf8',
  );
  console.log(`registry: ${entries.length} plugin(s) -> ${relative(root, registryFile)}`);
}

async function buildOne(author, name, folder) {
  const out = join(buildRoot, 'staging', `${author}.${name}`);
  const mainFile = join(out, 'main.mjs');

  await esbuild.build({
    entryPoints: [join(folder, 'src', 'index.ts')],
    outfile: mainFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    // Node's own modules stay imports; everything from npm is bundled in,
    // because an installed plugin has no node_modules to resolve from.
    packages: 'bundle',
    external: ['node:*'],
    logLevel: 'silent',
  });

  // The built module is the truth about the manifest.
  const module = await import(pathToFileURL(mainFile).href);
  const manifest = module.default?.manifest;
  if (!manifest || typeof manifest.id !== 'string') {
    throw new Error(`${author}/${name}: the built module does not export a manifest`);
  }

  const expected = `${author}.${name}`;
  if (manifest.id !== expected) {
    // The folder is the address and the id is the identity; the two agreeing
    // is what lets a person find a plugin's source from a profile.
    throw new Error(`${author}/${name}: manifest id is '${manifest.id}', folder says '${expected}'`);
  }

  const pluginJson = JSON.stringify(
    { id: manifest.id, main: 'main.mjs', ...storefront(manifest) },
    null,
    2,
  );
  await writeFile(join(out, 'plugin.json'), pluginJson, 'utf8');
  // The committed copy, so the repository shows what the store will show.
  await writeFile(join(folder, 'plugin.json'), pluginJson, 'utf8');

  for (const carried of CARRIED) {
    const source = join(folder, carried);
    if (await exists(source)) await cp(source, join(out, carried), { recursive: true });
  }

  // Renamed into place last, so a half-built folder never looks installable.
  const final = join(buildRoot, manifest.id);
  await cp(out, final, { recursive: true });
  await rm(out, { recursive: true, force: true });

  const bytes = (await stat(join(final, 'main.mjs'))).size;
  const sha256 = createHash('sha256')
    .update(await readFile(join(final, 'main.mjs')))
    .digest('hex');

  return {
    id: manifest.id,
    author,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    path: relative(root, final).replaceAll('\\', '/'),
    sha256,
    bytes,
    manifest: storefront(manifest),
  };
}

/** The manifest as the store shows it — everything but the id repeated. */
function storefront(manifest) {
  const { id, builtIn, ...rest } = manifest;
  return rest;
}

async function folders(parent) {
  try {
    const entries = await readdir(parent, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

await main().then(
  () => rm(join(buildRoot, 'staging'), { recursive: true, force: true }),
  (error) => {
    console.error(error.message);
    process.exit(1);
  },
);
