'use strict';
const { parseArgs } = require('node:util');

const DEFAULT_PORT = 5462;
const DEFAULT_HOST = '127.0.0.1';

// Throws on unknown flags or a bad port; the caller prints the message and exits 1.
function parseOptions(argv, env = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      open: { type: 'boolean' },
      'no-open': { type: 'boolean' },
      session: { type: 'string' },
    },
  });
  const rawPort = values.port ?? (env.PORT || String(DEFAULT_PORT));
  const port = /^\d+$/.test(rawPort) ? Number(rawPort) : NaN;
  if (!(port >= 0 && port <= 65535)) throw new Error(`invalid port: ${rawPort}`);
  return {
    port,
    host: values.host || DEFAULT_HOST,
    open: Boolean(values.open && !values['no-open']),
    session: values.session ?? null,
  };
}

module.exports = { parseOptions };
