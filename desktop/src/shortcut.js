// `npm run desktop:shortcut` - puts "Stefflix" shortcuts on the desktop and in the Start menu,
// so the app (still run from the project folder) starts with a double click.
// The installer of a later phase creates its own shortcuts and makes this unnecessary.
import fs from 'node:fs';
import path from 'node:path';
import { app, nativeImage, shell } from 'electron';

export const APP_USER_MODEL_ID = 'com.stefan.homestream.desktop';

/** Creates both shortcuts; returns the paths. Throws when Windows refuses. */
export function createShortcuts({ iconPng, dataDir }) {
  const icon = path.join(dataDir, 'stefflix.ico');
  writeIco(icon, nativeImage.createFromPath(iconPng));

  const startMenu = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const links = [path.join(app.getPath('desktop'), 'Stefflix.lnk'), path.join(startMenu, 'Stefflix.lnk')];

  for (const link of links) {
    const ok = shell.writeShortcutLink(link, 'create', {
      target: process.execPath,
      args: app.isPackaged ? '' : `"${app.getAppPath()}"`,
      cwd: app.getAppPath(),
      description: 'Stefflix – медиен сървър за телевизора',
      icon,
      iconIndex: 0,
      appUserModelId: APP_USER_MODEL_ID,
    });
    if (!ok) throw new Error(link);
  }
  return links;
}

/** Writes an .ico (shortcuts can't use a .png) with PNG-compressed images in several sizes. */
function writeIco(file, image, sizes = [16, 24, 32, 48, 64, 128, 256]) {
  const pngs = sizes.map((size) => image.resize({ width: size, height: size, quality: 'best' }).toPNG());

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);

  let offset = header.length + 16 * pngs.length;
  const entries = pngs.map((png, i) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(sizes[i] % 256, 0); // width (0 means 256)
    entry.writeUInt8(sizes[i] % 256, 1); // height
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([header, ...entries, ...pngs]));
}
