/*
 * web-ext configuration.
 *
 * web-ext reads this file automatically, so `npx web-ext lint` and
 * `npx web-ext build` both ignore the development-only files below and the
 * resulting add-on contains just the extension itself.
 */
export default {
  sourceDir: '.',
  artifactsDir: 'web-ext-artifacts',
  ignoreFiles: [
    'tools/**',
    'test/**',
    'README.md',
    'firefox_volume_mixer_extension_prompt.md',
    'web-ext-config.mjs',
    '.gitignore',
    // Not part of the add-on: the update manifest is fetched by Firefox from
    // its own URL, and .github/ only holds CI.
    'updates.json',
    '.github/**',
  ],
};