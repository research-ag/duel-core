// The only "build" this frontend needs: bundle src/main.ts (and every TS
// module it imports — the whole gameplay/physics/rendering tree, plus
// three/rxjs/@gg-web-engine/point-in-polygon from node_modules) into
// dist/main.js, and separately bundle src/duel/duel-app.js (which pulls
// in duel-racing-plugin.js and every duel-game-core/@icp-sdk module it
// imports) into dist/duel-app.js — two independent bundles sharing the
// same page, exactly as index.html loads them. Then copy everything else
// static-asset-canister-style. The deployed asset canister carries only
// this dist/ output — no node_modules directory of any kind.
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
    cpSync(from, to, { recursive: true });
  }
}

if (watch) {
  const ctxs = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(ctxs.map((ctx) => ctx.watch()));
  copyStaticAssets();
  // esbuild's own watchers only track main.ts's and duel-app.js's own
  // module graphs, which none of these belong to — watch them directly
  // so editing any one of them re-copies it into dist/ too.
  for (const file of ['src/index.html', 'src/style.css', 'src/favicon.ico', 'src/assets']) {
    watchFile(file, { recursive: true }, () => copyStaticAssets());
  }
  console.log('watching for changes...');
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
  copyStaticAssets();
}
