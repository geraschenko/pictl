#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { buildApplication, buildRouteMap, type RouteMap } from "@stricli/core";
import { cliLocalization, runCliApp, type CommandContext } from "./cli.ts";
import { attachCommand } from "./attach.ts";
import { holdCommand } from "./holder.ts";
import { listCommand, statusCommand } from "./inspect.ts";
import { gcCommand, lifecycleCommands } from "./lifecycle.ts";
import { rpcCommands } from "./rpc-commands.ts";
import { spawnCommand } from "./spawn.ts";
import { tailCommand } from "./tail.ts";
import { UsageError } from "./util.ts";
import { VERSION } from "./version.ts";
import { waitCommand, WaitTimeoutError } from "./wait.ts";

const coreCommands = {
  spawn: spawnCommand,
  list: listCommand,
  attach: attachCommand,
  status: statusCommand,
  wait: waitCommand,
  tail: tailCommand,
  gc: gcCommand,
} as const;

const internalCommands = {
  _hold: holdCommand,
} as const;

const routes = {
  ...coreCommands,
  ...lifecycleCommands,
  ...rpcCommands,
  ...internalCommands,
};

function routeIsCommon(route: unknown): boolean {
  return (route as { common?: true }).common === true;
}

const hideRoute = Object.fromEntries(
  Object.entries(routes)
    .filter(([, route]) => !routeIsCommon(route))
    .map(([name]) => [name, true]),
);

const root = buildRouteMap({
  routes: routes as never,
  docs: {
    brief: "Spawn, observe, control, and attach to pi agents",
    hideRoute,
  },
}) as RouteMap<CommandContext>;

export const app = buildApplication(root, {
  name: "pictl",
  versionInfo: { currentVersion: VERSION },
  scanner: {
    caseStyle: "allow-kebab-for-camel",
    allowArgumentEscapeSequence: true,
  },
  documentation: { onlyRequiredInUsageLine: true },
  determineExitCode: (error) =>
    error instanceof WaitTimeoutError ? 3 : error instanceof UsageError ? 2 : 1,
  localization: cliLocalization,
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runCliApp(app, process.argv.slice(2));
}
