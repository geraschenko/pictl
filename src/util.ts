/** Small shared helpers. Keep this file free of pi-ctl-specific imports. */

import { access } from "node:fs/promises";

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Split argv at the first `--` into our own args and pass-through args. */
export function splitAtDoubleDash(argv: string[]): {
  ownArgs: string[];
  passthroughArgs: string[];
} {
  const separatorIndex = argv.indexOf("--");
  return separatorIndex === -1
    ? { ownArgs: argv, passthroughArgs: [] }
    : {
        ownArgs: argv.slice(0, separatorIndex),
        passthroughArgs: argv.slice(separatorIndex + 1),
      };
}
