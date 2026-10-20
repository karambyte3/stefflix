// Fails the build if the bundle contains syntax newer than ES2016, which is
// roughly what Chromium 53 (webOS TV 4.x) understands. Catches e.g. async/await,
// object spread or optional chaining that slipped through the transpiler.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const distAssets = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'assets');
const files = readdirSync(distAssets).filter((f) => f.endsWith('.js'));
let failed = false;

for (const file of files) {
  const code = readFileSync(path.join(distAssets, file), 'utf8');
  try {
    parse(code, { ecmaVersion: 2016, sourceType: 'script' });
    console.log(`ok  ${file} is ES2016-compatible`);
  } catch (err) {
    failed = true;
    const snippet = code.slice(Math.max(0, err.pos - 60), err.pos + 60);
    console.error(`ERR ${file}: ${err.message}\n    ...${snippet}...`);
  }
}

if (failed) process.exit(1);
