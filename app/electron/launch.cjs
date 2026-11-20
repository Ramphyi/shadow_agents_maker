// Starts Electron as an app. Terminals inside editors built on Electron (VS Code and friends) can export
// ELECTRON_RUN_AS_NODE, which would make the binary behave like plain Node and never open a window.
const { spawn } = require('node:child_process');
const path = require('node:path');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
spawn(electron, [path.join(__dirname, '..'), ...process.argv.slice(2)], { stdio: 'inherit', env })
  .on('exit', (code) => process.exit(code ?? 0));
