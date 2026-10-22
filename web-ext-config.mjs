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
    'web-ext-config.mjs',
    '.gitignore',
  ],
};