#!/usr/bin/env node
import { runCli } from "./cli.ts";

// TDC: It feels wrong that main.ts is just routing to another file like this ... why this indirection?
await runCli(process.argv.slice(2));
