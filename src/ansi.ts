/**
 * ANSI escape sequences shared by the holder and the attach client. Keep this
 * file free of pi-ctl-specific imports.
 */

export const SHOW_CURSOR = "\x1b[?25h";
export const HIDE_CURSOR = "\x1b[?25l";
export const DISABLE_BRACKETED_PASTE = "\x1b[?2004l";
export const RESET_SGR = "\x1b[0m";
export const CURSOR_HOME = "\x1b[H";
export const ERASE_SCREEN = "\x1b[2J";
/** DECSC/DECRC: save/restore cursor position AND SGR attributes. */
export const SAVE_CURSOR = "\x1b7";
export const RESTORE_CURSOR = "\x1b8";

export function cursorToRow(row: number): string {
  return `\x1b[${row};1H`;
}
