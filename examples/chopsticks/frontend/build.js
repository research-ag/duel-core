// Bundle the app into dist/ and copy the static assets; icp.yaml deploys
// dist/ only.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync, watch as watchFile } from 'node:fs';

const watch = process.argv.includes('--watch');
const outdir = 'dist';

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const buildOptions = {
  entryPoints: ['src/app.js'],
  bundle: true,
  outfile: `${outdir}/app.js`,
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  logLevel: 'info',
};

const staticAssets = [
  ['src/index.html', `${outdir}/index.html`],
  ['src/style.css', `${outdir}/style.css`],
  ['src/.ic-assets.json5', `${outdir}/.ic-assets.json5`],
  ['src/assets', `${outdir}/assets`],
];

function copyStaticAssets() {
  for (const [from, to] of staticAssets) {
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
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  copyStaticAssets();
  // Static files are outside esbuild's module graph: watch the directory
  // (a per-file watch dies on an atomic rename) and debounce.
  const staticNames = ['index.html', 'style.css', '.ic-assets.json5'];
  let debounceTimer;
  watchFile('src', (_event, filename) => {
    if (filename && !staticNames.includes(filename)) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(copyStaticAssets, 50);
  });
  console.log('watching for changes...');
} else {
  await esbuild.build(buildOptions);
  copyStaticAssets();
}
