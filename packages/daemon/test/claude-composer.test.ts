import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { readClaudeComposer, stripFaintAndStyles } from "../src/domain/claude-composer.js";

// Real `tmux capture-pane -p -e` captures of Claude Code 2.1.295 (vim mode, accept-edits footer).
const fixture = (name: string) => readFileSync(new URL(`./fixtures/claude-composer/${name}.ansi`, import.meta.url), "utf8");

describe("readClaudeComposer", () => {
  it("reads an empty box as empty", () => {
    expect(readClaudeComposer(fixture("empty"))).toEqual({ state: "empty", stashed: false });
  });

  it("reads a one-line draft", () => {
    expect(readClaudeComposer(fixture("oneline"))).toEqual({ state: "draft", text: "3 A, 4 yes", stashed: false });
  });

  it("reads a multi-line draft", () => {
    expect(readClaudeComposer(fixture("multiline"))).toEqual({ state: "draft", text: "first line\nsecond line\nindented third", stashed: false });
  });

  it("sees Claude's stash indicator below an empty box", () => {
    expect(readClaudeComposer(fixture("stashed-empty"))).toEqual({ state: "empty", stashed: true });
  });

  it("sees a draft typed over an existing stash", () => {
    expect(readClaudeComposer(fixture("draft-with-stash"))).toEqual({ state: "draft", text: "other", stashed: true });
  });

  it("treats Claude's faint prompt suggestion as an empty box, not a draft", () => {
    const suggestion = fixture("empty").replace("\u001b[39m❯ \n", "\u001b[39m❯ \u001b[2mrig queue list\u001b[0m\n");
    expect(suggestion).toContain("rig queue list");
    expect(readClaudeComposer(suggestion)).toEqual({ state: "empty", stashed: false });
  });

  it("keeps typed text before a faint completion", () => {
    const partial = fixture("empty").replace("\u001b[39m❯ \n", "\u001b[39m❯ rig\u001b[2m queue list\u001b[22m\n");
    expect(readClaudeComposer(partial)).toEqual({ state: "draft", text: "rig", stashed: false });
  });

  it("reads unknown without an input frame", () => {
    expect(readClaudeComposer(null)).toMatchObject({ state: "unknown" });
    expect(readClaudeComposer("some output\nmore output\n")).toMatchObject({ state: "unknown", reason: "no_input_frame" });
    // A permission dialog: bordered, but its first row is not the prompt.
    expect(readClaudeComposer([
      "─".repeat(40),
      " Bash command",
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "─".repeat(40),
      " Esc to cancel · Tab to amend",
    ].join("\n"))).toMatchObject({ state: "unknown", reason: "no_prompt_line" });
  });
});

describe("stripFaintAndStyles", () => {
  it("drops faint runs and escape sequences, keeping other styled text", () => {
    expect(stripFaintAndStyles("\u001b[38;5;246ma\u001b[39m\u001b[2;3mb\u001b[0mc\u001b]8;;http://x\u0007d\u001b]8;;\u0007")).toBe("acd");
  });
});
