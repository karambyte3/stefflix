// Resets the LG Developer Mode session timer (replacement for the old `ares-extend-dev`,
// which @webos-tools/cli no longer ships).
//
// The Developer Mode app stores its session token on the TV in
// /var/luna/preferences/devmode_enabled; sending it to LG's ResetDevModeSession
// endpoint extends the session to the full duration again.
// Device name defaults to "tv"; override with TV_DEVICE.
import { execSync } from 'node:child_process';

const device = process.env.TV_DEVICE || 'tv';

let token;
try {
  token = execSync(`ares-novacom --device ${device} --run "cat /var/luna/preferences/devmode_enabled"`, {
    encoding: 'utf8',
  }).trim();
} catch (err) {
  console.error(`Could not read the session token from device "${device}". Is the TV on and set up with ares-setup-device?`);
  process.exit(1);
}

if (!/^[0-9a-fA-F]+$/.test(token)) {
  console.error(`Unexpected session token: "${token}"`);
  process.exit(1);
}

const url = `https://developer.lge.com/secure/ResetDevModeSession.dev?sessionToken=${token}`;
const res = await fetch(url);
const body = (await res.text()).trim();
console.log(`LG response (${res.status}): ${body}`);
if (!res.ok) process.exit(1);
console.log('Done. Open the Developer Mode app on the TV to see the new remaining time.');
