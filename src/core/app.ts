import { buildApplication, buildRouteMap, text_en } from "@stricli/core";
import { attachRoute } from "./attach.ts";
import { type CommandContext } from "./targets.ts";
import { completionRoute } from "./completion.ts";
import { internalRoutes } from "./daemon.ts";
import { listRoute, statusRoute } from "./inspect.ts";
import { formatRoute } from "../format/command.ts";
import { gcRoute, lifecycleRoutes } from "./lifecycle.ts";
import { rpcRoutes } from "./rpc-commands.ts";
import { spawnRoute } from "./spawn.ts";
import { tailRoute } from "./tail.ts";
import { UsageError } from "./util.ts";
import { VERSION } from "./version.ts";
import { UntilTimeoutError } from "./until.ts";
import { waitRoute } from "./wait.ts";

const routes = {
  ...spawnRoute,
  ...listRoute,
  ...attachRoute,
  ...statusRoute,
  ...waitRoute,
  ...tailRoute,
  ...gcRoute,
  ...lifecycleRoutes,
  ...completionRoute,
  format: formatRoute,
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

export const app = buildApplication<CommandContext>(root, {
  name: "pictl",
  versionInfo: { currentVersion: VERSION },
  scanner: {
    caseStyle: "allow-kebab-for-camel",
    allowArgumentEscapeSequence: true,
  },
  documentation: {
    useAliasInUsageLine: true,
    alwaysShowHelpAllFlag: true,
  },
  completion: {
    includeAliases: true,
    includeHiddenRoutes: true,
  },
  localization: {
    text: {
      ...text_en,
      exceptionWhileParsingArguments(exc, ansiColor) {
        if (exc instanceof UsageError) {
          return exc.message;
        }
        return text_en.exceptionWhileParsingArguments.call(
          this,
          exc,
          ansiColor,
        );
      },
      exceptionWhileRunningCommand(exc, ansiColor) {
        if (exc instanceof Error) {
          return exc.message;
        }
        return text_en.exceptionWhileRunningCommand.call(this, exc, ansiColor);
      },
      commandErrorResult(err) {
        return err.message;
      },
    },
  },
  determineExitCode: (error) =>
    error instanceof UntilTimeoutError
      ? 3
      : error instanceof UsageError
        ? 2
        : 1,
});
