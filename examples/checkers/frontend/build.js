// The only "build" this frontend needs: bundle src/app.js (which pulls in
// checkers-plugin.js and every duel-game-core/@icp-sdk module it imports)
// into one dist/app.js, then copy the static assets alongside it. The
// deployed asset canister carries only this dist/ output — no
// node_modules directory of any kind.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

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

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log('watching for changes...');
} else {
  await esbuild.build(buildOptions);
}

for (const [from, to] of [
  ['src/index.html', `${outdir}/index.html`],
  ['src/style.css', `${outdir}/style.css`],
  ['src/.ic-assets.json5', `${outdir}/.ic-assets.json5`],
  ['node_modules/duel-game-core/style.css', `${outdir}/duel-game-core.css`],
]) {
  cpSync(from, to, { recursive: true });
}
