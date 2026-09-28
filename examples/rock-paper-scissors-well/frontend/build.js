// The only "build" this frontend needs: bundle src/app.js (which pulls in
// rpsw-plugin.js and every duel-game-core/@icp-sdk module it imports) into
// one dist/app.js, then copy the static assets alongside it. The deployed
// asset canister carries only this dist/ output — no node_modules
// directory of any kind.
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
  ['node_modules/duel-game-core/style.css', `${outdir}/duel-game-core.css`],
];

function copyStaticAssets() {
  for (const [from, to] of staticAssets) {
    cpSync(from, to, { recursive: true });
  }
}

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  copyStaticAssets();
  // esbuild's own watcher only tracks app.js's module graph, which none
  // of these three belong to — watch the directory they live in (not
  // each file individually: an editor's atomic save replaces a file via
  // rename, which can silently stop a per-file fs.watch from firing
  // again) and filter to just their names.
  const staticNames = ['index.html', 'style.css', '.ic-assets.json5'];
  watchFile('src', (_event, filename) => {
    if (filename && staticNames.includes(filename)) copyStaticAssets();
  });
  console.log('watching for changes...');
} else {
  await esbuild.build(buildOptions);
  copyStaticAssets();
}
