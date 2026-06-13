#!/usr/bin/env node
import { DETACH_KEY_NAME, runAttach } from "./attach.ts";
import { runHold } from "./holder.ts";
import { runGc, runList, runStatus } from "./inspect.ts";
import { runKill, runResume, runSuspend } from "./lifecycle.ts";
import { rpcCommandHandlers, rpcCommandUsage } from "./rpc-commands.ts";
import { runSpawn } from "./spawn.ts";
import { UsageError } from "./util.ts";

const COMMANDS: Record<string, (argv: string[]) => Promise<void>> = {
  spawn: runSpawn,
  _hold: runHold,
  attach: runAttach,
  list: runList,
  status: runStatus,
  kill: runKill,
  suspend: runSuspend,
  resume: runResume,
  gc: runGc,
  ...rpcCommandHandlers(),
};

function usage(): never {
  console.error(`usage: pi-ctl <command> [args]

commands:
  spawn [--cwd <dir>] [--id <id>] [-- <pi args...>]     start a new agent, print its id
  attach <agent>                                        attach this terminal (detach: ${DETACH_KEY_NAME})
  list [--json]                                         list agents and their status
  status <agent>... [--json]                            detailed status of agents
  kill <agent>... [--timeout <secs>] [--now] [--force]  wait for quiescence, then kill and remove
  suspend <agent>... [--timeout <secs>]                 wait for quiescence, then stop (agent goes dormant)
  resume <agent>...                                     revive dormant agents on their last sessions
  gc                                                    remove tombstoned or corrupt agent dirs

RPC passthrough (sent to the agent's pi process; --json prints the raw response):
${rpcCommandUsage()}

<agent> accepts an agent id, a session id (unique prefixes work for both), or a
workflow role name when $PI_WORKFLOW_DIR is set (RPC commands also accept
--workflow <dir>); roles come from the "agents" map in <dir>/state.json.`);
  process.exit(2);
}

const [command, ...argv] = process.argv.slice(2);
const handler = command === undefined ? undefined : COMMANDS[command];
if (!handler) {
  if (command !== undefined) {
    console.error(`pi-ctl: unknown command: ${command}\n`);
  }
  usage();
}

try {
  await handler(argv);
} catch (error) {
  console.error(
    `pi-ctl: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(error instanceof UsageError ? 2 : 1);
}
