// Bundle src/main.ts and src/duel/duel-app.js into dist/ and copy the
// static assets; icp.yaml deploys dist/ only.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync, watch as watchFile } from 'node:fs';

const watch = process.argv.includes('--watch');
const outdir = 'dist';

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const builds = [
  {
    entryPoints: ['src/main.ts'],
    bundle: true,
    outfile: `${outdir}/main.js`,
    format: 'esm',
    target: 'es2022',
    sourcemap: true,
    logLevel: 'info',
  },
  {
    entryPoints: ['src/duel/duel-app.js'],
    bundle: true,
    outfile: `${outdir}/duel-app.js`,
    format: 'esm',
    target: 'es2022',
    sourcemap: true,
    logLevel: 'info',
  },
];

const staticAssets = [
  ['src/index.html', `${outdir}/index.html`],
  ['src/style.css', `${outdir}/style.css`],
  ['src/favicon.ico', `${outdir}/favicon.ico`],
  ['src/assets', `${outdir}/assets`],
  ['node_modules/duel-game-core/style.css', `${outdir}/duel-game-core.css`],
];

function copyStaticAssets() {
  for (const [from, to] of staticAssets) {
    // cpSync never prunes, so clear the destination first.
    rmSync(to, { recursive: true, force: true });
    try {
      cpSync(from, to, { recursive: true });
    } catch (err) {
      if (err.code !== 'ENOENT' || !watch) throw err;
      // An editor's atomic save can briefly remove a file; the debounced
      // watcher retries.
      console.warn(`skipping copy, ${from} not found (will retry)`);
    }
  }
}

if (watch) {
  const ctxs = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(ctxs.map((ctx) => ctx.watch()));
  copyStaticAssets();
  // Static files are outside esbuild's module graph: watch the directory
  // (a per-file watch dies on an atomic rename) and debounce.
  const staticNames = ['index.html', 'style.css', 'favicon.ico'];
  let debounceTimer;
  const scheduleCopy = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(copyStaticAssets, 50);
  };
  watchFile('src', (_event, filename) => {
    if (!filename || staticNames.includes(filename)) scheduleCopy();
  });
  watchFile('src/assets', { recursive: true }, scheduleCopy);
  console.log('watching for changes...');
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
  copyStaticAssets();
}
