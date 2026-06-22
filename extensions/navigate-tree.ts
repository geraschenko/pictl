/**
 * /navigate-tree — agent self-navigation of its own conversation tree.
 *
 * A running agent cannot navigate its own tree mid-turn: the `navigate_tree` RPC
 * is rejected while streaming, which is exactly the agent's state when it runs a
 * command from inside its turn. This extension registers a `/navigate-tree` slash
 * command that is accepted inline during streaming, returns immediately (so the
 * turn can finish), and detaches a task that waits for the run to settle, then
 * navigates, then optionally sends a continuation prompt on the new branch.
 *
 * See docs/specs/self-navigation-extension.md.
 */

import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionCommandContext } from "@geraschenko/pi-coding-agent";

/** Parsed form of the /navigate-tree argument string. */
interface NavigateArgs {
  /** Required positional entry id. */
  targetId: string;
  /** --label value; passed to navigateTree, which labels targetId (see spec surface note). */
  label?: string;
  /** Verbatim continuation text from --continue (rest-of-line). */
  continuation?: string;
  /** Path from --continue-file; resolved to text by the handler. */
  continuationFile?: string;
}

const FLAG_LABEL = "--label";
const FLAG_CONTINUE = "--continue";
const FLAG_CONTINUE_FILE = "--continue-file";

/**
 * Parse the raw argument string (everything after "/navigate-tree ").
 *
 * Token-level grammar: the first standalone `--continue` token ends flag parsing
 * and consumes the entire raw remainder verbatim (embedded spaces, quotes,
 * slashes, and flag-looking text are all literal). Before that point, `--label`
 * and `--continue-file` each consume one following token, and the first bare
 * (non-flag) token is `targetId`.
 *
 * Throws (all caught by pi as command-error events) on: a missing `targetId`;
 * both `--continue` and `--continue-file`; an empty/whitespace-only `--continue`;
 * and — failing closed against malformed commands — an unknown `--flag`, a flag
 * missing its value, a duplicate `--label`/`--continue-file`, or a second
 * positional argument. (Empty `--continue-file` contents are rejected by the
 * handler after reading the file.)
 */
function parseNavigateArgs(raw: string): NavigateArgs {
  let targetId: string | undefined;
  let label: string | undefined;
  let continuation: string | undefined;
  let continuationFile: string | undefined;

  const isSpace = (index: number): boolean => /\s/.test(raw[index]);

  let i = 0;
  const n = raw.length;
  while (i < n) {
    while (i < n && isSpace(i)) i++;
    if (i >= n) break;

    const tokenStart = i;
    while (i < n && !isSpace(i)) i++;
    const token = raw.slice(tokenStart, i);

    if (token === FLAG_CONTINUE) {
      if (continuationFile !== undefined) {
        throw new Error("--continue and --continue-file are mutually exclusive");
      }
      // Consume the raw remainder verbatim, skipping one separating whitespace char.
      const restStart = i < n ? i + 1 : i;
      continuation = raw.slice(restStart);
      if (continuation.trim() === "") {
        throw new Error("--continue requires non-empty continuation text");
      }
      break;
    }

    if (token === FLAG_LABEL || token === FLAG_CONTINUE_FILE) {
      while (i < n && isSpace(i)) i++;
      if (i >= n) {
        throw new Error(`${token} requires a value`);
      }
      const valueStart = i;
      while (i < n && !isSpace(i)) i++;
      const value = raw.slice(valueStart, i);
      if (token === FLAG_LABEL) {
        if (label !== undefined) throw new Error("--label given more than once");
        label = value;
      } else {
        if (continuationFile !== undefined) throw new Error("--continue-file given more than once");
        continuationFile = value;
      }
      continue;
    }

    if (token.startsWith("--")) {
      throw new Error(`unknown flag: ${token}`);
    }

    if (targetId !== undefined) {
      throw new Error(`unexpected argument: ${token}`);
    }
    targetId = token;
  }

  if (targetId === undefined) {
    throw new Error("targetId is required");
  }

  return { targetId, label, continuation, continuationFile };
}

export default function navigateTreeExtension(pi: ExtensionAPI): void {
  pi.registerCommand("navigate-tree", {
    description: "Navigate the agent's own conversation tree after the current run settles.",
    handler: async (raw: string, ctx: ExtensionCommandContext): Promise<void> => {
      const { targetId, label, continuation: parsedContinuation, continuationFile } = parseNavigateArgs(raw);

      let continuation = parsedContinuation;
      if (continuation === undefined && continuationFile !== undefined) {
        const text = await readFile(continuationFile, "utf8");
        if (text.trim() === "") {
          throw new Error(`--continue-file ${continuationFile} is empty`);
        }
        continuation = text;
      }

      const navOptions = label !== undefined ? { label } : {};
      void (async () => {
        try {
          // TODO: switch to ctx.waitForSettled() once it lands in the pinned pi
          // (docs/specs/self-navigation-extension.md → Dependencies). waitForIdle
          // resolves at the end of a single run and races auto-retry/compaction;
          // waitForSettled resolves only at full session quiescence.
          await ctx.waitForIdle();
          const result = await ctx.navigateTree(targetId, navOptions);
          if (continuation !== undefined && !result.cancelled) {
            pi.sendUserMessage(continuation); // verbatim; void; reports its own async errors
          }
        } catch (err) {
          // Report out of band; never throw out of the detached task. Accessing
          // ctx.ui itself asserts the session is still active, so if the session
          // was replaced (the best-effort lifecycle case) the report is silently
          // dropped rather than escaping as an unhandled rejection.
          try {
            ctx.ui.notify(`navigate-tree failed: ${err instanceof Error ? err.message : String(err)}`, "error");
          } catch {
            // Session no longer active; nothing left to report to.
          }
        }
      })();
    },
  });
}

export { parseNavigateArgs };
export type { NavigateArgs };
