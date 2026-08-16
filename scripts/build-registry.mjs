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
import { dirname, extname, join, relative, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import esbuild from 'esbuild';

// The host's own ZIP writer, from the checkout beside this one. Borrowed
// rather than reimplemented so an archive this script makes and an archive
// the app reads are the same format by construction — and so a bug in one is
// a bug in both, found once.
import { writeZip } from '../../EasyDeck/packages/core/dist/infrastructure/zip-writer.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginsRoot = join(root, 'plugins');
const buildRoot = join(root, 'build');
const registryFile = join(root, 'registry', 'index.json');

/** The folders the host reads as data; everything else is source. */
const CARRIED = ['icons', 'locales', 'assets', 'natives'];

/**
 * What an installable plugin is called.
 *
 * The same extension a profile uses, on purpose: both are a zip with a
 * manifest inside, both arrive by being dropped on the window, and asking
 * somebody to remember which extension goes with which kind of thing is
 * asking them to do the program's job. What is inside says which it is — a
 * `plugin.json` is a plugin, a profile's document is a profile.
 */
const EXTENSION = '.easydeck';

/** Compressing an already-compressed picture costs time and saves nothing. */
const ALREADY_COMPRESSED = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.zip']);

async function main() {
  await rm(buildRoot, { recursive: true, force: true });
  const entries = [];

  for (const author of await folders(pluginsRoot)) {
    for (const name of await folders(join(pluginsRoot, author))) {
      const folder = join(pluginsRoot, author, name);
      const entry = await buildOne(author, name, folder);
      entries.push(entry);
      console.log(`built ${entry.file} — ${entry.version}, ${(entry.bytes / 1024).toFixed(0)} KB`);
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
    banner: {
      // CommonJS dependencies — ws is one — call require('events') at run
      // time, and an ESM bundle has no require to give them. This hands them
      // the real one instead of esbuild's shim that only knows how to throw.
      js: "import { createRequire as __edCreateRequire } from 'node:module'; const require = __edCreateRequire(import.meta.url);",
    },
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

  /*
   * Renamed into place last, so a half-built folder never looks installable.
   *
   * The folder stays beside the archive rather than instead of it: copying one
   * into the plugins folder is how a plugin is tried during development, and
   * the archive is how it travels.
   */
  const final = join(buildRoot, manifest.id);
  await cp(out, final, { recursive: true });
  await rm(out, { recursive: true, force: true });

  const archive = `${manifest.id}${EXTENSION}`;
  const bytes = writeZip(await pack(final));
  await writeFile(join(buildRoot, archive), bytes);

  /*
   * The full manifest, in a file of its own.
   *
   * It used to ride inside the index, and it was 97 to 99 per cent of every
   * entry there: four plugins made a hundred-kilobyte index, of which one and
   * a half kilobytes was what a list actually draws. A store paid for every
   * plugin's actions, variables, settings and presets in order to show four
   * names — and would have paid a megabyte at fifty plugins.
   *
   * So the index carries the row and this carries the card, fetched when
   * somebody opens one.
   */
  await writeFile(
    join(buildRoot, `${manifest.id}.json`),
    JSON.stringify(storefront(manifest), null, 2),
    'utf8',
  );

  return {
    id: manifest.id,
    author,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    /** What to fetch. A file beside the index today, a URL when there is one. */
    file: archive,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
    /*
     * What a row needs, and nothing more: a name, a line about it, and one
     * small picture. Everything else is in the manifest beside this.
     */
    name: manifest.name,
    ...(manifest.description ? { description: manifest.description } : {}),
    ...(manifest.author ? { by: manifest.author } : {}),
    ...(manifest.cover ? { cover: manifest.cover } : {}),
  };
}

/**
 * Every file of a built plugin, as ZIP entries.
 *
 * Paths inside the archive are relative to the plugin's own folder and use
 * forward slashes, so unpacking it *is* creating `plugins/<id>/`. Sorted, so
 * building the same plugin twice makes the same archive — which is what lets
 * a hash mean "this is that plugin" rather than "this was built at that
 * moment".
 */
async function pack(folder, prefix = '') {
  const files = [];
  const entries = (await readdir(folder, { withFileTypes: true })).sort((one, other) =>
    one.name.localeCompare(other.name),
  );

  for (const entry of entries) {
    const path = join(folder, entry.name);
    const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`;

    if (entry.isDirectory()) {
      files.push(...(await pack(path, name)));
      continue;
    }

    files.push({
      name,
      bytes: await readFile(path),
      compress: !ALREADY_COMPRESSED.has(extname(entry.name).toLowerCase()),
    });
  }

  return files;
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
