// The icon next to the clock: shows the server status and the TV address, and has the main actions.
import { Menu, Tray, nativeImage } from 'electron';
import { bg, format } from './i18n/bg.js';

/**
 * @param {string} iconFile  square PNG (transparent background)
 * @param {object} actions   { open, copyAddress, scan, restart, setAutostart, quit }
 * @returns {{ update(view): void }}
 */
export function createTray(iconFile, actions) {
  const tray = new Tray(trayImage(iconFile));
  tray.on('click', actions.open);

  function update(view) {
    const t = bg.tray;
    const status = bg.status[view.status] || view.status;
    tray.setToolTip(
      view.tvAddress ? format(t.tooltipRunning, { address: view.tvAddress }) : format(t.tooltipOther, { status })
    );

    const addressItems = view.tvAddress
      ? [
          { label: format(t.tvAddress, { address: view.tvAddress }), enabled: false },
          { label: t.copyAddress, click: actions.copyAddress },
        ]
      : [];

    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: format(t.statusLine, { status }), enabled: false },
        ...addressItems,
        { type: 'separator' },
        { label: t.open, click: actions.open },
        { label: t.scan, enabled: view.status === 'running', click: actions.scan },
        { label: t.restart, click: actions.restart },
        { type: 'separator' },
        {
          label: t.autostart,
          type: 'checkbox',
          checked: view.autostart,
          click: (item) => actions.setAutostart(item.checked),
        },
        { type: 'separator' },
        { label: t.quit, click: actions.quit },
      ])
    );
  }

  return { update };
}

/** 16 px at 100% display scaling, sharper versions for 150% and 200%. */
function trayImage(file) {
  const source = nativeImage.createFromPath(file);
  const image = nativeImage.createEmpty();
  for (const scaleFactor of [1, 1.5, 2]) {
    const size = Math.round(16 * scaleFactor);
    image.addRepresentation({
      scaleFactor,
      width: size,
      height: size,
      buffer: source.resize({ width: size, height: size, quality: 'best' }).toPNG(),
    });
  }
  return image;
}
