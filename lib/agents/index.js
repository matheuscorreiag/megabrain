// Agent adapters by `agent.type` in config.json. An adapter exports
// { name, spawnArgs, userMessage, interruptMessage, createParser } — see
// claude.js for the contract and the neutral events a parser emits.

import { createClaudeAgent } from './claude.js';

const ADAPTERS = {
  claude: createClaudeAgent,
};

export function createAgent(options) {
  const create = ADAPTERS[options.type];
  if (!create) throw new Error(`unknown agent "${options.type}" (available: ${Object.keys(ADAPTERS).join(', ')})`);
  return create(options);
}
