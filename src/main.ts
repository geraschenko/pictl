#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildApplication, buildRouteMap } from "@stricli/core";
import { cliLocalization, runCliApp } from "./cli.ts";
import { attachRoute } from "./attach.ts";
import { internalRoutes } from "./holder.ts";
import { listRoute, statusRoute } from "./inspect.ts";
import { gcRoute, lifecycleRoutes } from "./lifecycle.ts";
import { rpcRoutes } from "./rpc-commands.ts";
import { spawnRoute } from "./spawn.ts";
import { tailRoute } from "./tail.ts";
import { UsageError } from "./util.ts";
import { VERSION } from "./version.ts";
import { waitRoute, WaitTimeoutError } from "./wait.ts";

const routes = {
  ...spawnRoute,
  ...listRoute,
  ...attachRoute,
  ...statusRoute,
  ...waitRoute,
  ...tailRoute,
  ...gcRoute,
  ...lifecycleRoutes,
  ...rpcRoutes,
  ...internalRoutes,
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
  routes,
  docs: {
    brief: "Spawn, observe, control, and attach to pi agents",
    hideRoute,
  },
});

export const app = buildApplication(root, {
  name: "pictl",
  versionInfo: { currentVersion: VERSION },
  scanner: {
    caseStyle: "allow-kebab-for-camel",
    allowArgumentEscapeSequence: true,
  },
  determineExitCode: (error) =>
    error instanceof WaitTimeoutError ? 3 : error instanceof UsageError ? 2 : 1,
  localization: cliLocalization,  // TDC: delete this line?
});

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  realpathSync(entryPath) === fileURLToPath(import.meta.url)
) {
  await runCliApp(app, process.argv.slice(2));
}
