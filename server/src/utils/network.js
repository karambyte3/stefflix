import os from 'node:os';

// Adapters that are almost never the one the TV can reach.
const VIRTUAL_ADAPTER = /vethernet|virtualbox|vmware|hyper-v|wsl|loopback|bluetooth|tailscale|zerotier|docker|vpn/i;

function isPrivateIPv4(address) {
  return (
    address.startsWith('192.168.') ||
    address.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address)
  );
}

/**
 * Returns the PC's IPv4 LAN addresses, best guess first.
 */
export function getLanAddresses() {
  const candidates = [];

  for (const [name, infos] of Object.entries(os.networkInterfaces())) {
    for (const info of infos || []) {
      const isIPv4 = info.family === 'IPv4' || info.family === 4;
      if (!isIPv4 || info.internal) continue;

      let score = 0;
      if (isPrivateIPv4(info.address)) score += 2;
      if (info.address.startsWith('192.168.')) score += 1;
      if (VIRTUAL_ADAPTER.test(name)) score -= 3;
      if (info.address.startsWith('169.254.')) score -= 5; // link-local, no DHCP

      candidates.push({ name, address: info.address, score });
    }
  }

  return candidates.sort((a, b) => b.score - a.score);
}
