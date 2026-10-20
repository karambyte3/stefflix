import { defineConfig } from 'vite';

// webOS TV 4.x (2019 LG TVs) runs Chromium 53: no ES modules, no async/await,
// no object spread. Everything below exists to produce a bundle that engine can run.
const TARGET = 'chrome53';

/**
 * Vite always emits <script type="module" crossorigin>. Chromium 53 ignores module
 * scripts, and "crossorigin" breaks loading from file:// in the packaged app,
 * so turn the entry into a plain deferred classic script.
 */
function classicScriptForWebOS() {
  return {
    name: 'classic-script-for-webos',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml(html) {
      return html
        .replace(/<script type="module" crossorigin/g, '<script defer')
        .replace(/<script type="module"/g, '<script defer')
        .replace(/ crossorigin/g, '');
    },
  };
}

export default defineConfig({
  // Relative asset URLs: the packaged app is loaded from file://
  base: './',
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: TARGET,
    cssTarget: TARGET,
    modulePreload: false,
    assetsInlineLimit: 0,
    // A single <link>ed stylesheet instead of CSS injected from JS.
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        // One classic script instead of ES module chunks.
        format: 'iife',
      },
    },
  },
  plugins: [classicScriptForWebOS()],
});
