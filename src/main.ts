#!/usr/bin/env node
import { DETACH_KEY_NAME, runAttach } from "./attach.ts";
import { runHold } from "./holder.ts";
import { runList, runStatus } from "./inspect.ts";
import {
  runArchive,
  runGc,
  runPurge,
  runResume,
  runSuspend,
} from "./lifecycle.ts";
import { rpcCommandHandlers, rpcCommandUsage } from "./rpc-commands.ts";
import { runSpawn } from "./spawn.ts";
import { runTail } from "./tail.ts";
import { UsageError } from "./util.ts";
import { runWait, WAIT_UNTIL_USAGE, WaitTimeoutError } from "./wait.ts";

const COMMANDS: Record<string, (argv: string[]) => Promise<void>> = {
  spawn: runSpawn,
  _hold: runHold,
  attach: runAttach,
  list: runList,
  status: runStatus,
  suspend: runSuspend,
  archive: runArchive,
  resume: runResume,
  purge: runPurge,
  gc: runGc,
  wait: runWait,
  tail: runTail,
  ...rpcCommandHandlers(),
};

function usage(): never {
  console.error(`usage: pi-ctl <command> [args]

commands:
  spawn [--cwd <dir>] [--id <id>] [--tag <label>] [-- <pi args...>]  start an agent, print its id
  attach <agent>                                        attach this terminal (detach: ${DETACH_KEY_NAME})
  list [--cwd <dir>] [--all] [--json]                   list agents and their status
  status <agent>... [--json]                            detailed status of agents
  suspend <agent>... [--timeout <secs>]                 wait until idle, then stop (agent goes dormant)
  archive <agent>... [--timeout <secs>]                 suspend, then hide from list (until resumed)
  resume <agent>...                                     revive dormant agents on their last sessions
  purge <agent>... [--timeout <secs>] [--now] [--force] wait until idle, then delete permanently
  gc                                                    remove tombstoned or corrupt agent dirs
  wait <agent> --until ${WAIT_UNTIL_USAGE} [--timeout <secs>]
                                                        block until the agent meets the condition
                                                        (exit 3 if --timeout expires first)
  tail <agent> [--follow] [--since <entry-id>] [--until <cond>]
                                                        session entries as JSONL, then a cursor
                                                        record; --follow streams new entries,
                                                        --until <cond> follows until the condition,
                                                        --events streams raw events instead

RPC passthrough (sent to the agent's pi process; --json prints the raw response):
${rpcCommandUsage()}

<agent> accepts an agent id (unique prefixes work). Use --tag at spawn time and
list --cwd <dir> to find agents working in a shared directory.`);
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
  process.exit(
    error instanceof WaitTimeoutError ? 3 : error instanceof UsageError ? 2 : 1,
  );
}
