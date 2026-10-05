// The only "build" this frontend needs: bundle src/main.tsx (React + every
// @icp-sdk import it pulls in) into one dist/app.js, then copy the static
// assets alongside it. The deployed frontend canister carries only this
// dist/ output — no node_modules directory of any kind. Mirrors
// ../../examples/007/frontend/build.js's own shape.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const outdir = 'dist';

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const buildOptions = {
  entryPoints: ['src/main.tsx'],
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
  ['src/fonts', `${outdir}/fonts`],
  ['src/_headers', `${outdir}/_headers`],
]) {
  cpSync(from, to, { recursive: true });
}
