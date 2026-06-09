/**
 * Design system — semantic ANSI color tokens.
 *
 * Inspired by bun, pnpm, npm CLI conventions.
 * Degrades cleanly: NO_COLOR or non-TTY → no ANSI codes.
 *
 * Tokens:
 *   heading  — bold cyan (table headers, section titles)
 *   cmd      — cyan (command names, executable references)
 *   arg      — dim (argument placeholders)
 *   success  — green (OK, ready, added, updated, complete)
 *   error    — red (failed, fatal errors)
 *   warn     — yellow (warnings, stale, unreachable)
 *   dim      — dim (separators, total line, secondary info)
 *   info     — cyan (daemon lifecycle messages)
 *   label    — dim (status labels: "Daemon:", "Ollama:", etc.)
 *   highlight — bold (important values, search label)
 */

const noColor = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;

function s(code: number) {
  return noColor ? "" : `\x1b[${code}m`;
}

export const c = {
  reset: s(0),

  // Semantic
  heading:   s(1) + s(36),  // bold cyan
  cmd:       s(36),         // cyan
  arg:       s(2),          // dim
  success:   s(32),         // green
  error:     s(31),         // red
  warn:      s(33),         // yellow
  dim:       s(2),          // dim
  info:      s(36),         // cyan
  label:     s(2),          // dim
  highlight: s(1),          // bold
  muted:     s(90),         // gray

  // Raw (for composing)
  bold:      s(1),
  cyan:      s(36),
  green:     s(32),
  red:       s(31),
  yellow:    s(33),
  gray:      s(90),
} as const;
