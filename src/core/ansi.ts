/**
 * ANSI escape sequences shared by the daemon and the attach client. Keep this
 * file free of pictl-specific imports.
 */

export const SHOW_CURSOR = "\x1b[?25h";
export const HIDE_CURSOR = "\x1b[?25l";
export const DISABLE_BRACKETED_PASTE = "\x1b[?2004l";
/** Disable mouse tracking and extended coordinate encodings. */
export const DISABLE_MOUSE_REPORTING =
  "\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l";
export const RESET_SGR = "\x1b[0m";
export const CURSOR_HOME = "\x1b[H";
export const ERASE_SCREEN = "\x1b[2J";
/** DECSC/DECRC: save/restore cursor position AND SGR attributes. */
export const SAVE_CURSOR = "\x1b7";
export const RESTORE_CURSOR = "\x1b8";

/** CUP with 1-based coordinates. */
export function cursorTo(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

export function cursorToRow(row: number): string {
  return cursorTo(row, 1);
}
