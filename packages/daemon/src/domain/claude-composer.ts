// Reads Claude Code's input box from a styled (`capture-pane -e`) capture, so a delivery can tell a
// person's unsent draft from an empty box before it pastes. Claude renders its prompt suggestion
// ("❯ rig queue list") as faint (SGR 2) text in an EMPTY box; a plain capture cannot tell that from
// a typed draft, so faint runs are dropped here. The box is the last bordered block:
//
//   ───────────── label ─       upper border (an optional seat label)
//   ❯ first draft line           prompt glyph (`!` in bash mode), then any continuation lines
//   ──────────────────────       lower border
//   ⏵⏵ accept edits on … › stashed   footer rows; "stashed" means Claude holds a stashed prompt
//
// Anything else reads unknown: no frame is evidence of neither a draft nor an empty box.

export type ClaudeComposerRead =
  | { state: "empty"; stashed: boolean }
  | { state: "draft"; text: string; stashed: boolean }
  | { state: "unknown"; reason: string };

const LOWER_BORDER = /^─{3,}$/;
const UPPER_BORDER = /^─{3,}(?: \S.* ─+)?$/;
const PROMPT_LINE = /^[❯!][\s\u00a0]?/;
const MAX_FOOTER_LINES = 5;
const MAX_COMPOSER_LINES = 60;

/** Drop faint (SGR 2) runs and every escape sequence, keeping the visible typed text. */
export function stripFaintAndStyles(line: string): string {
  let out = "";
  let faint = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch !== "\u001b") {
      if (!faint) out += ch;
      continue;
    }
    const next = line[i + 1];
    if (next === "[") {
      let j = i + 2;
      while (j < line.length && !/[@-~]/.test(line[j]!)) j++;
      if (line[j] === "m") {
        const params = line.slice(i + 2, j).split(/[;:]/);
        for (const p of params.length ? params : [""]) {
          if (p === "" || p === "0" || p === "22") faint = false;
          else if (p === "2") faint = true;
        }
      }
      i = j;
    } else if (next === "]") {
      // OSC (hyperlinks): up to BEL or ST.
      let j = i + 2;
      while (j < line.length && line[j] !== "\u0007" && !(line[j] === "\u001b" && line[j + 1] === "\\")) j++;
      i = line[j] === "\u0007" ? j : j + 1;
    } else {
      i += 1;
    }
  }
  return out;
}

export function readClaudeComposer(styledCapture: string | null): ClaudeComposerRead {
  if (!styledCapture) return { state: "unknown", reason: "no_capture" };
  const lines = styledCapture.split("\n").map((raw) => ({ raw, plain: stripFaintAndStyles(raw).replace(/\s+$/, "") }));
  const visible = (i: number) => lines[i]!.plain.trim().length > 0;
  let end = lines.length - 1;
  while (end >= 0 && !visible(end)) end--;
  if (end < 0) return { state: "unknown", reason: "empty_capture" };

  let lower = -1;
  for (let i = end, footer = 0; i >= 0 && footer <= MAX_FOOTER_LINES; i--) {
    if (!visible(i)) continue;
    if (LOWER_BORDER.test(lines[i]!.plain.trim())) { lower = i; break; }
    footer++;
  }
  if (lower < 0) return { state: "unknown", reason: "no_input_frame" };

  let upper = -1;
  for (let i = lower - 1; i >= 0 && lower - i <= MAX_COMPOSER_LINES + 1; i--) {
    if (UPPER_BORDER.test(lines[i]!.plain.trim())) { upper = i; break; }
  }
  if (upper < 0 || upper === lower - 1) return { state: "unknown", reason: "no_input_frame" };

  const body = lines.slice(upper + 1, lower).map((l) => l.plain);
  const first = body[0]!.trimStart();
  if (!PROMPT_LINE.test(first)) return { state: "unknown", reason: "no_prompt_line" };
  const text = [first.replace(PROMPT_LINE, ""), ...body.slice(1).map((l) => l.trim())].join("\n").replace(/\u00a0/g, " ").trim();
  const stashed = lines.slice(lower + 1, end + 1).some((l) => /\bstashed\b/.test(l.plain));
  return text.length === 0 ? { state: "empty", stashed } : { state: "draft", text, stashed };
}
