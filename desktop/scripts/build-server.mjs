// Prepares the server for the installer (`npm run dist`): bundles server/src into one file and
// copies the one native module next to it. electron-builder puts the result in resources/server:
//
//   resources/server/server.mjs                                 server/src/index.js + every JS dependency
//   resources/server/vendor/better-sqlite3/                     lib/ + the Windows x64 prebuilt binary
//
// better-sqlite3 stays a real package because it loads its .node file relative to its own folder.
// It's in "vendor", not "node_modules": electron-builder leaves node_modules folders out of extraResources.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import esbuild from 'esbuild';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.resolve(desktopDir, '..', 'server');
const outDir = path.join(desktopDir, 'bundle', 'server');

fs.rmSync(outDir, { recursive: true, force: true });

await esbuild.build({
  entryPoints: [path.join(serverDir, 'src', 'index.js')],
  outfile: path.join(outDir, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  plugins: [
    {
      name: 'vendor-better-sqlite3',
      setup(build) {
        build.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: './vendor/better-sqlite3/lib/index.js', external: true }));
      },
    },
  ],
  // CommonJS dependencies (express, iconv-lite...) call require() for Node's own modules,
  // which an ES module bundle doesn't have on its own.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'warning',
});

// better-sqlite3: its JS and only the Windows x64 binary (the other platforms are dead weight).
const require = createRequire(path.join(serverDir, 'package.json'));
const sqliteDir = path.dirname(require.resolve('better-sqlite3/package.json'));
const sqliteOut = path.join(outDir, 'vendor', 'better-sqlite3');
fs.cpSync(path.join(sqliteDir, 'lib'), path.join(sqliteOut, 'lib'), { recursive: true });
fs.copyFileSync(path.join(sqliteDir, 'package.json'), path.join(sqliteOut, 'package.json'));
fs.copyFileSync(path.join(sqliteDir, 'LICENSE'), path.join(sqliteOut, 'LICENSE'));
fs.mkdirSync(path.join(sqliteOut, 'prebuilds'));
fs.copyFileSync(path.join(sqliteDir, 'prebuilds', 'win32-x64.node'), path.join(sqliteOut, 'prebuilds', 'win32-x64.node'));

const size = fs.statSync(path.join(outDir, 'server.mjs')).size;
console.log(`Server bundled into ${path.relative(desktopDir, outDir)} (server.mjs ${(size / 1024).toFixed(0)} KB)`);
