'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { parseOptions } = require('../lib/args');
const { agentDir, inspectDir } = require('../lib/agent-dir');

test('defaults: port 5462 on 127.0.0.1, no browser', () => {
  assert.deepEqual(parseOptions([], {}), { port: 5462, host: '127.0.0.1', open: false, session: null });
});

test('--port wins over PORT, and 0 is allowed', () => {
  assert.equal(parseOptions(['--port', '0'], { PORT: '7000' }).port, 0);
  assert.equal(parseOptions([], { PORT: '7000' }).port, 7000);
  assert.equal(parseOptions([], { PORT: '' }).port, 5462);
});

test('--no-open wins over --open', () => {
  assert.equal(parseOptions(['--open'], {}).open, true);
  assert.equal(parseOptions(['--open', '--no-open'], {}).open, false);
});

test('host and session flags', () => {
  const o = parseOptions(['--host', '0.0.0.0', '--session', 'abc'], {});
  assert.equal(o.host, '0.0.0.0');
  assert.equal(o.session, 'abc');
});

test('bad input throws', () => {
  for (const port of ['-1', '65536', 'abc', '1.5', '']) {
    assert.throws(() => parseOptions([`--port=${port}`], {}), /invalid port/, port);
  }
  assert.throws(() => parseOptions(['--bogus'], {}), /Unknown option/);
});

test('agent dir follows PI_CODING_AGENT_DIR like pi', () => {
  const home = os.homedir();
  assert.equal(agentDir({}), path.join(home, '.pi', 'agent'));
  assert.equal(agentDir({ PI_CODING_AGENT_DIR: '~' }), home);
  assert.equal(agentDir({ PI_CODING_AGENT_DIR: '~/.pi-dev/agent' }), path.join(home, '.pi-dev', 'agent'));
  assert.equal(agentDir({ PI_CODING_AGENT_DIR: 'rel/dir' }), path.resolve('rel/dir'));
  assert.equal(inspectDir({ PI_CODING_AGENT_DIR: '~' }), path.join(home, 'inspect'));
});
