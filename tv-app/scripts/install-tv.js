// Installs the packaged .ipk on the TV. The file name contains the app version,
// so it's read from appinfo.json instead of being hard-coded in package.json.
// Device name defaults to "tv" (the name given in `ares-setup-device`); override with TV_DEVICE.
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appinfo = JSON.parse(readFileSync(path.join(appRoot, 'public', 'appinfo.json'), 'utf8'));
const ipk = path.join('build', `${appinfo.id}_${appinfo.version}_all.ipk`);
const device = process.env.TV_DEVICE || 'tv';

if (!existsSync(path.join(appRoot, ipk))) {
  console.error(`${ipk} not found - run "npm run package" first.`);
  process.exit(1);
}

execSync(`ares-install --device ${device} "${ipk}"`, { cwd: appRoot, stdio: 'inherit' });
