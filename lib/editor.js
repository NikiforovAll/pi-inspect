'use strict';
const { spawn } = require('node:child_process');

function editorCommand(env = process.env) {
  return env.EDITOR || env.VISUAL || (process.platform === 'win32' ? 'code' : 'vi');
}

// Detached, so closing the dashboard server leaves the editor open.
function openInEditor(file, env = process.env) {
  const editor = editorCommand(env);
  const isWin = process.platform === 'win32';
  const [cmd, ...rest] = editor.split(/\s+/);
  const args = [...rest, file];
  // `code` is a .cmd shim on Windows, which only runs through a shell.
  const child = spawn(cmd, isWin ? args.map((a) => `"${String(a).replace(/"/g, '\\"')}"`) : args, {
    detached: true,
    stdio: 'ignore',
    shell: isWin,
    windowsVerbatimArguments: isWin,
  });
  child.on('error', (err) => console.warn(`pi-inspect: open failed: ${err.message}`));
  child.unref();
  return editor;
}

module.exports = { openInEditor };
