// Best-effort guess whether the TV's HTML5 player (LG webOS 4.x) can play a file.
// The TV app shows these as "this file may not be supported" warnings; nothing is blocked.
import path from 'node:path';

const RISKY_CONTAINERS = ['avi'];
const SUPPORTED_VIDEO = ['h264', 'hevc', 'vp8', 'vp9'];
// LG removed DTS from 2019 models; TrueHD was never supported.
const SUPPORTED_AUDIO = ['aac', 'ac3', 'eac3', 'mp3', 'mp2', 'opus', 'vorbis'];

/**
 * @param {string} filePath
 * @param {object|null} probe  stream info from services/probe.js (null without ffprobe)
 * @returns {{ probed: boolean, warnings: Array<{ code: 'container'|'video'|'audio', value: string }> }}
 */
export function checkCompatibility(filePath, probe) {
  const warnings = [];
  const ext = path.extname(filePath).slice(1).toLowerCase();

  if (RISKY_CONTAINERS.includes(ext)) warnings.push({ code: 'container', value: ext });

  if (probe) {
    if (probe.video && probe.video.codec && !SUPPORTED_VIDEO.includes(probe.video.codec)) {
      warnings.push({ code: 'video', value: probe.video.codec });
    }
    // The player uses the default audio track, or the first one.
    const audio = probe.audio.find((a) => a.default) || probe.audio[0];
    if (audio && audio.codec && !SUPPORTED_AUDIO.includes(audio.codec)) {
      warnings.push({ code: 'audio', value: audio.codec });
    }
  }

  return { probed: !!probe, warnings };
}
