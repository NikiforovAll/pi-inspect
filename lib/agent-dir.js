'use strict';
const os = require('node:os');
const path = require('node:path');

// Same rule as pi's getAgentDir: PI_CODING_AGENT_DIR with ~ expanded, else ~/.pi/agent.
function agentDir(env = process.env) {
  const dir = env.PI_CODING_AGENT_DIR;
  if (!dir) return path.join(os.homedir(), '.pi', 'agent');
  if (dir === '~') return os.homedir();
  if (/^~[\\/]/.test(dir)) return path.join(os.homedir(), dir.slice(2));
  return path.resolve(dir);
}

function inspectDir(env = process.env) {
  return path.join(agentDir(env), 'inspect');
}

module.exports = { agentDir, inspectDir };
