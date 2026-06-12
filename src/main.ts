#!/usr/bin/env node
import { runHold } from "./holder.js";
import { runGc, runList, runStatus } from "./inspect.js";
import { runKill, runResume, runSuspend } from "./lifecycle.js";
import { runSpawn } from "./spawn.js";

const COMMANDS: Record<string, (argv: string[]) => Promise<void>> = {
	spawn: runSpawn,
	_hold: runHold,
	list: runList,
	status: runStatus,
	kill: runKill,
	suspend: runSuspend,
	resume: runResume,
	gc: runGc,
};

function usage(): never {
	console.error(`usage: pi-ctl <command> [args]

commands:
  spawn [--cwd <dir>] [--id <id>] [-- <pi args...>]     start a new agent, print its id
  list [--json]                                         list agents and their status
  status <agent>... [--json]                            detailed status of agents
  kill <agent>... [--timeout <secs>] [--now] [--force]  wait for quiescence, then kill and remove
  suspend <agent>... [--timeout <secs>]                 wait for quiescence, then stop (agent goes dormant)
  resume <agent>...                                     revive dormant agents on their last sessions
  gc                                                    remove tombstoned or corrupt agent dirs

<agent> accepts any unique id prefix.`);
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
	console.error(`pi-ctl: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
