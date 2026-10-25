'use strict';
const fs = require('node:fs');

// fs.watch fires several events per write, so changes are batched into one call per quiet period.
function watchSnapshots(dir, onChange, { delayMs = 150 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  let timer = null;
  const changed = new Set();
  // libuv aborts when it watches a Windows 8.3 short path (C:\Users\NAME~1\...), so watch the long form.
  const watcher = fs.watch(fs.realpathSync.native(dir), (_event, filename) => {
    const name = filename && String(filename);
    if (!name || !name.endsWith('.json')) return;
    changed.add(name);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const files = [...changed];
      changed.clear();
      onChange(files);
    }, delayMs);
  });
  return {
    close() {
      clearTimeout(timer);
      watcher.close();
    },
  };
}

module.exports = { watchSnapshots };
