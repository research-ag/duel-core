// The only "build" this frontend needs: bundle src/main.ts (and every TS
// module it imports — the whole gameplay/physics/rendering tree, plus
// three/rxjs/@gg-web-engine/point-in-polygon from node_modules) into one
// dist/main.js, then copy everything else static-asset-canister-style.
//
// duel-app.js and duel-racing-plugin.js are NOT bundled — they're plain,
// dependency-free ESM that import @dfinity/agent from esm.sh and
// duel-game-core by its on-disk path at runtime (see duel-app.js's own
// comments), same as the 007 example's frontend. They're just copied.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const outdir = 'dist';

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const buildOptions = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: `${outdir}/main.js`,
  format: 'esm',
  target: 'es2020',
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
  ['src/favicon.ico', `${outdir}/favicon.ico`],
  ['src/duel/duel-app.js', `${outdir}/duel-app.js`],
  ['src/duel/duel-racing-plugin.js', `${outdir}/duel-racing-plugin.js`],
  ['src/assets', `${outdir}/assets`],
  ['node_modules/duel-game-core', `${outdir}/node_modules/duel-game-core`],
]) {
  cpSync(from, to, { recursive: true });
}
