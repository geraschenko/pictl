#!/usr/bin/env node
import type { RpcCommand, RpcResponse, RpcSessionState } from "@earendil-works/pi-coding-agent";

function usage(): never {
	console.error("usage: pi-ctl <spawn|list|status|kill|suspend|resume|gc> ...");
	process.exit(2);
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
	case undefined:
		usage();
	default:
		console.error(`pi-ctl: unknown command: ${command}`);
		process.exit(2);
}
