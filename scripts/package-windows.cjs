const path = require('node:path');
const { packager } = require('@electron/packager');

packager({
  dir: path.resolve(__dirname, '..'),
  name: 'MP API',
  executableName: 'MP API',
  platform: 'win32',
  arch: 'x64',
  out: 'dist',
  prune: true,
  asar: true,
  overwrite: true,
  ignore: /^\/(?:data|exports|logs|dist|test|scripts|\.git)(?:\/|$)/,
}).then(paths => {
  for (const location of paths) console.log(location);
}).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
