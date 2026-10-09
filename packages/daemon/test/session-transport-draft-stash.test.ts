import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { createFullTestDb } from "./helpers/test-app.js";

// A Claude Code input box, modelled on Claude 2.1.295's ctrl+s (chat:stash): on a non-empty box
// it stashes the text and empties the box; on an empty box it pops an existing stash. Submitting
// a prompt restores a held stash into the box.
class FakeClaudeBox {
  value = "";
  stash: string | null = null;
  suggestion = "";
  submitted: string[] = [];
  keys: string[] = [];
  restoreOnSubmit = true;
  stashKeyWorks = true;
  styledCapture = true;
  /** Reads after Enter that still show the pre-submit box (Claude has not redrawn yet). */
  lagReads = 0;
  private lagged: { value: string; stash: string | null; reads: number } | null = null;
  /** Text a person types between OpenRig's reads and writes. */
  onKey?: (key: string) => void;

  render(): string {
    const body = this.value === ""
      ? [`\u001b[39m❯ ${this.suggestion ? `\u001b[2m${this.suggestion}\u001b[0m` : ""}`]
      : this.value.split("\n").map((line, i) => (i === 0 ? `\u001b[39m❯ ${line}` : `  ${line}`));
    return [
      "⏺ ACK earlier message",
      "",
      `\u001b[38;5;244m${"─".repeat(40)} seat ─`,
      ...body,
      `\u001b[38;5;244m${"─".repeat(56)}`,
      `\u001b[39m  ⏵⏵ accept edits on (shift+tab to cycle)${this.stash !== null ? "   \u001b[38;5;246m› stashed\u001b[39m" : ""}`,
    ].join("\n");
  }

  plain(): string {
    // What the plain capture shows: the suggestion is indistinguishable from typed text.
    const shown = this.value || this.suggestion;
    return `⏺ ACK earlier message\n\n${"─".repeat(40)}\n❯ ${shown}\n${"─".repeat(40)}\n  ⏵⏵ accept edits on (shift+tab to cycle)`;
  }

  tmux(): TmuxAdapter {
    const ok = { ok: true as const };
    const adapter: Record<string, unknown> = {
      hasSession: async () => true,
      probeSession: async () => ({ state: "present" as const }),
      sendText: async (_t: string, text: string): Promise<TmuxResult> => { this.value += text; return ok; },
      sendKeys: async (_t: string, keys: string[]): Promise<TmuxResult> => {
        for (const key of keys) {
          this.keys.push(key);
          if (key === "C-s" && this.stashKeyWorks) {
            if (this.value.trim() !== "") { this.stash = this.value; this.value = ""; }
            else if (this.stash !== null) { this.value = this.stash; this.stash = null; }
          } else if (key === "Enter") {
            if (this.lagReads > 0) this.lagged = { value: this.value, stash: this.stash, reads: this.lagReads };
            this.submitted.push(this.value);
            this.value = "";
            if (this.stash !== null && this.restoreOnSubmit) { this.value = this.stash; this.stash = null; }
          }
          this.onKey?.(key);
        }
        return ok;
      },
      capturePaneContent: async () => this.plain(),
      listPanes: async () => [],
      getPanePid: async () => null,
      getPaneCommand: async () => null,
    };
    if (this.styledCapture) adapter.capturePaneStyled = async () => {
      if (!this.lagged || this.lagged.reads-- <= 0) return this.render();
      const [value, stash] = [this.value, this.stash];
      Object.assign(this, { value: this.lagged.value, stash: this.lagged.stash });
      try { return this.render(); } finally { Object.assign(this, { value, stash }); }
    };
    return adapter as unknown as TmuxAdapter;
  }
}

describe("rig send over a person's unsent Claude Code draft", () => {
  let db: Database.Database;
  let box: FakeClaudeBox;
  let transport: SessionTransport;

  beforeEach(() => {
    db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const rig = rigRepo.createRig("draft-rig");
    const node = rigRepo.addNode(rig.id, "dev.lead", { role: "worker", runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "dev-lead@draft-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-lead@draft-rig" });
    box = new FakeClaudeBox();
    transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: box.tmux(), sleep: async () => {} });
  });

  afterEach(() => db.close());

  const send = (text = "MSG from orch") => transport.send("dev-lead@draft-rig", text);

  it("submits the message alone and puts a one-line draft back unsubmitted", async () => {
    box.value = "3 A, 4 yes";
    const result = await send();
    expect(result).toMatchObject({ ok: true, draft: "restored" });
    expect(result.warning).toContain("draft put back in the input box unsubmitted");
    expect(box.submitted).toEqual(["MSG from orch"]);
    expect(box.value).toBe("3 A, 4 yes");
    expect(box.stash).toBeNull();
    expect(box.keys).toEqual(["C-s", "Enter"]);
  });

  it("keeps a multi-line draft byte-identical", async () => {
    box.value = "first line\nsecond line\n  indented third";
    const result = await send();
    expect(result).toMatchObject({ ok: true, draft: "restored" });
    expect(box.submitted).toEqual(["MSG from orch"]);
    expect(box.value).toBe("first line\nsecond line\n  indented third");
  });

  it("handles a draft that contains the message's own text", async () => {
    box.value = "MSG from orch";
    const result = await send();
    expect(result).toMatchObject({ ok: true, draft: "restored" });
    expect(box.submitted).toEqual(["MSG from orch"]);
    expect(box.value).toBe("MSG from orch");
  });

  it("delivers to an empty box as before, pressing no stash key", async () => {
    const result = await send();
    expect(result.ok).toBe(true);
    expect(result.draft).toBeUndefined();
    expect(box.keys).toEqual(["Enter"]);
    expect(box.submitted).toEqual(["MSG from orch"]);
    expect(box.value).toBe("");
  });

  it("does not treat a faint prompt suggestion as a draft", async () => {
    box.suggestion = "rig queue list";
    const result = await send();
    expect(result.ok).toBe(true);
    expect(result.draft).toBeUndefined();
    expect(box.keys).toEqual(["Enter"]);
    expect(box.submitted).toEqual(["MSG from orch"]);
    expect(box.value).toBe("");
  });

  it("never presses ctrl+s on an empty box holding the person's own stash (it would pop it)", async () => {
    box.stash = "my stashed thought";
    const result = await send();
    expect(result.ok).toBe(true);
    expect(box.keys).toEqual(["Enter"]);
    expect(box.submitted).toEqual(["MSG from orch"]);
  });

  it("refuses rather than overwrite an existing stash with the draft", async () => {
    box.value = "draft";
    box.stash = "older stash";
    const result = await send();
    expect(result).toMatchObject({ ok: false, sent: false, reason: "target_needs_input" });
    expect(result.error).toContain("already holds a stashed prompt");
    expect(box.keys).toEqual([]);
    expect(box.submitted).toEqual([]);
    expect(box).toMatchObject({ value: "draft", stash: "older stash" });
  });

  it("refuses without pasting when the stash key does not clear the box", async () => {
    box.value = "draft";
    box.stashKeyWorks = false;
    const result = await send();
    expect(result).toMatchObject({ ok: false, sent: false, reason: "target_needs_input" });
    expect(result.error).toContain("still in the box");
    expect(box.submitted).toEqual([]);
    expect(box.value).toBe("draft");
  });

  it("waits for Claude to redraw after Enter instead of reporting the still-visible message", async () => {
    box.value = "draft";
    box.lagReads = 2;
    const result = await send();
    expect(result).toMatchObject({ ok: true, draft: "restored" });
    expect(box.keys).toEqual(["C-s", "Enter"]);
    expect(box.value).toBe("draft");
  });

  it("pops the stash itself when Claude did not restore it on submit", async () => {
    box.value = "draft";
    box.restoreOnSubmit = false;
    const result = await send();
    expect(result).toMatchObject({ ok: true, draft: "restored" });
    expect(box.keys).toEqual(["C-s", "Enter", "C-s"]);
    expect(box.submitted).toEqual(["MSG from orch"]);
    expect(box.value).toBe("draft");
  });

  it("reports an unconfirmed restore instead of pressing ctrl+s over new typing", async () => {
    box.value = "draft";
    box.restoreOnSubmit = false;
    box.onKey = (key) => { if (key === "Enter") box.value = "new typing"; };
    const result = await send();
    expect(result).toMatchObject({ ok: true, draft: "restore-unconfirmed" });
    expect(result.warning).toContain("ctrl+s on an empty box restores it");
    expect(box.keys).toEqual(["C-s", "Enter"]);
    expect(box).toMatchObject({ value: "new typing", stash: "draft" });
  });

  it("keeps today's behaviour when the box cannot be read", async () => {
    box.styledCapture = false;
    transport = new SessionTransport({
      db, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db), tmuxAdapter: box.tmux(), sleep: async () => {},
    });
    const result = await send();
    expect(result.ok).toBe(true);
    expect(box.keys).toEqual(["Enter"]);
  });

  it("stashes a draft that the readiness classifier already recognised, instead of refusing", async () => {
    box.value = "half a thought";
    // The older plain-capture shape the readiness check reads as prompt_draft.
    const adapter = box.tmux() as unknown as Record<string, unknown>;
    adapter.capturePaneContent = async () => `❯ ${box.value}\n⏵⏵ accept edits on (shift+tab to cycle)`;
    transport = new SessionTransport({
      db, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db), tmuxAdapter: adapter as unknown as TmuxAdapter, sleep: async () => {},
    });
    const result = await send();
    expect(result).toMatchObject({ ok: true, draft: "restored" });
    expect(box.submitted).toEqual(["MSG from orch"]);
    expect(box.value).toBe("half a thought");
  });

  it("still refuses a recognised draft it cannot read in the styled capture", async () => {
    box.value = "half a thought";
    box.styledCapture = false;
    const adapter = box.tmux() as unknown as Record<string, unknown>;
    adapter.capturePaneContent = async () => `❯ ${box.value}\n⏵⏵ accept edits on (shift+tab to cycle)`;
    transport = new SessionTransport({
      db, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db), tmuxAdapter: adapter as unknown as TmuxAdapter, sleep: async () => {},
    });
    const result = await send();
    expect(result).toMatchObject({ ok: false, reason: "target_needs_input" });
    expect(box.keys).toEqual([]);
    expect(box.value).toBe("half a thought");
  });
});
