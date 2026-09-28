// The only "build" this frontend needs: bundle src/app.js (which pulls in
// checkers-plugin.js and every duel-game-core/@icp-sdk module it imports)
// into one dist/app.js, then copy the static assets alongside it. The
// deployed asset canister carries only this dist/ output — no
// node_modules directory of any kind.
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
  // of these three belong to — watch them directly so editing any one
  // of them re-copies it into dist/ too.
  for (const file of ['src/index.html', 'src/style.css', 'src/.ic-assets.json5']) {
    watchFile(file, () => copyStaticAssets());
  }
  console.log('watching for changes...');
} else {
  await esbuild.build(buildOptions);
  copyStaticAssets();
}
