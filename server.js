#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { parseOptions } = require('./lib/args');
const { inspectDir } = require('./lib/agent-dir');
const { createApp, SESSION_PATH } = require('./lib/app');
const { createSnapshotStore } = require('./lib/snapshot');
const { watchSnapshots } = require('./lib/watch');

let options;
try {
  options = parseOptions(process.argv.slice(2));
} catch (e) {
  console.error(`pi-inspect: ${e.message}`);
  process.exit(1);
}

const INSPECT_DIR = inspectDir();
const store = createSnapshotStore(path.join(INSPECT_DIR, 'snapshots'));
const { app, broadcast } = createApp({ store, inspectDir: INSPECT_DIR, host: options.host });

watchSnapshots(store.dir, (files) => broadcast('snapshot', { files }));

const server = app.listen(options.port, options.host, async (err) => {
  if (err) {
    console.error(`pi-inspect: cannot listen on port ${options.port}: ${err.message}`);
    process.exit(1);
  }
  const base = `http://localhost:${server.address().port}`;
  console.log(`pi-inspect listening on ${base}`);
  if (!options.open) return;
  const url = options.session ? base + SESSION_PATH.replace('{id}', encodeURIComponent(options.session)) : base;
  const { default: open } = await import('open');
  open(url).catch(() => {});
});
