/**
 * inject-env.js — kept as a no-op for backwards-compat with netlify.toml.
 *
 * Previously this injected the Google Maps API key into HTML at build time.
 * We now fetch it at runtime from /api/config so drag-and-drop ZIP deploys
 * work without a build step.
 */
console.log('inject-env.js: nothing to do (runtime config is used instead)');
