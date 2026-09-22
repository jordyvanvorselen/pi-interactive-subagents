/**
 * Herdr surface layer — the only terminal multiplexer this extension supports.
 *
 * Everything the extension does to a pane goes through the small API in this
 * file: create/split a pane, type a command into it, read its screen, close
 * it, and poll for exit. Keeping the herdr calls isolated here means index.ts
 * stays testable without a multiplexer running.
 *
 * Panes are identified by Herdr pane ids (e.g. `w1:p12`). A subagent spawned
 * by the main session gets its own tab; a subagent spawned by another
 * subagent splits its parent's pane, so one tab holds one lineage. Splits
 * always target the parent pi's pane (`$HERDR_PANE_ID`) so they follow the
 * agent rather than the user's focus. All calls go through the `herdr` CLI,
 * which inherits the session and socket from the pane environment.
 *
 * Launching uses the raw pane surface on purpose: the child runs inside a
 * shell wrapper that exports env, cds, and echoes an exit sentinel, none of
 * which `herdr agent start` can do. Steering a running child goes through
 * the agent surface (`herdr agent prompt`) so Herdr honours bracketed paste
 * and refuses to type over an approval or question dialog.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

// ── Availability ──

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

/**
 * Path to the herdr binary. Herdr exports `HERDR_BIN_PATH` into every pane
 * it manages; fall back to PATH lookup otherwise.
 */
function herdrBin(): string {
  return process.env.HERDR_BIN_PATH || "herdr";
}

/**
 * True when running inside a Herdr-managed pane with the herdr binary
 * reachable. Herdr sets `HERDR_ENV=1` in every process it spawns.
 */
export function isHerdrAvailable(): boolean {
  return process.env.HERDR_ENV === "1" && (!!process.env.HERDR_BIN_PATH || hasCommand("herdr"));
}

export function isMuxAvailable(): boolean {
  return isHerdrAvailable();
}

export function muxSetupHint(): string {
  return "Start pi inside a Herdr pane (run `herdr`, then `pi`).";
}

function requireHerdr(): void {
  if (!isHerdrAvailable()) {
    throw new Error(`Herdr is required for subagents. ${muxSetupHint()}`);
  }
}

// ── CLI helpers ──

/**
 * Run a herdr CLI command and parse its JSON stdout. Server errors arrive as
 * JSON on stderr with exit status 1; surface their message.
 */
function herdrJson(args: string[]): any {
  let stdout: string;
  try {
    stdout = execFileSync(herdrBin(), args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error: any) {
    throw new Error(`herdr ${args[0]} ${args[1] ?? ""} failed: ${herdrErrorMessage(error)}`);
  }
  return parseHerdrResponse(stdout);
}

async function herdrJsonAsync(args: string[]): Promise<any> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(herdrBin(), args, { encoding: "utf8" }));
  } catch (error: any) {
    throw new Error(`herdr ${args[0]} ${args[1] ?? ""} failed: ${herdrErrorMessage(error)}`);
  }
  return parseHerdrResponse(stdout);
}

function parseHerdrResponse(stdout: string): any {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const parsed = JSON.parse(trimmed);
  if (parsed?.error) {
    throw new Error(`${parsed.error.code}: ${parsed.error.message}`);
  }
  return parsed?.result ?? parsed;
}

function herdrErrorMessage(error: any): string {
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  if (stderr) {
    try {
      const parsed = JSON.parse(stderr);
      if (parsed?.error?.message) {
        return `${parsed.error.code}: ${parsed.error.message}`;
      }
    } catch {}
    return stderr;
  }
  return error?.message ?? String(error);
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── Pane layout ──

/**
 * Where a new subagent pane goes, relative to the parent pi pane.
 * "right" and "down" always split that way. "auto" follows the Herdr
 * guidance: split a wide pane to the right and a narrow or tall pane down.
 * Override with PI_SUBAGENT_SPLIT_DIRECTION.
 */
const SUBAGENT_SPLIT_DIRECTION: "right" | "down" | "auto" = "auto";

function splitDirectionSetting(): "right" | "down" | "auto" {
  const raw = process.env.PI_SUBAGENT_SPLIT_DIRECTION?.trim();
  return raw === "right" || raw === "down" || raw === "auto" ? raw : SUBAGENT_SPLIT_DIRECTION;
}

/**
 * Which surface a top-level subagent gets. "tab" gives every subagent of the
 * main session its own tab, so the tab bar reads as a list of running
 * subagents and each lineage keeps its own pane layout. "pane" keeps the old
 * behaviour of splitting the main session's pane.
 * Override with PI_SUBAGENT_TOP_LEVEL_SURFACE.
 */
const SUBAGENT_TOP_LEVEL_SURFACE: "tab" | "pane" = "tab";

function topLevelSurfaceSetting(): "tab" | "pane" {
  const raw = process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE?.trim();
  return raw === "tab" || raw === "pane" ? raw : SUBAGENT_TOP_LEVEL_SURFACE;
}

/**
 * True when this pi is itself a subagent, i.e. it was launched by another pi
 * with PI_SUBAGENT_NAME exported into its pane. Its children split its pane
 * instead of opening a tab.
 */
export function isNestedSpawner(): boolean {
  return !!process.env.PI_SUBAGENT_NAME?.trim();
}

/**
 * Decide where a new subagent surface goes: a tab for the main session, a
 * split for a subagent spawning its own children.
 */
export function chooseSurfaceKind(
  nested: boolean = isNestedSpawner(),
  setting: "tab" | "pane" = topLevelSurfaceSetting(),
): "tab" | "pane" {
  return !nested && setting === "tab" ? "tab" : "pane";
}

/**
 * Pick the split direction for a new pane off `pane`. Terminal cells are
 * roughly twice as tall as wide, so a pane is "wide" when it has more than
 * two columns per row. Falls back to "right" when the layout can't be read.
 */
export function chooseSplitDirection(
  layout: LayoutSnapshot | undefined,
  pane: string,
  setting: "right" | "down" | "auto" = splitDirectionSetting(),
): "right" | "down" {
  if (setting !== "auto") return setting;
  const rect = layout?.panes.find((p) => p.pane_id === pane)?.rect;
  if (!rect || rect.height === 0) return "right";
  return rect.width / rect.height >= 2 ? "right" : "down";
}

interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutSnapshot {
  zoomed: boolean;
  area: LayoutRect;
  focused_pane_id: string;
  panes: Array<{ pane_id: string; focused: boolean; rect: LayoutRect }>;
  splits: Array<{ id: string; direction: "right" | "down"; ratio: number; rect: LayoutRect }>;
}

function readLayout(pane: string): LayoutSnapshot | undefined {
  try {
    return herdrJson(["pane", "layout", "--pane", pane])?.layout as LayoutSnapshot | undefined;
  } catch {
    return undefined;
  }
}

let rebalanceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Re-balance subagent panes so repeated splits don't leave them lopsided.
 * Herdr halves the target pane on every split and hands freed space to the
 * sibling on close, so without this panes drift to wildly uneven sizes.
 *
 * Herdr has no named layouts. Instead this reads the tab layout and, for
 * every split, resizes the pane at the split boundary so each column (or
 * row) gets an equal share (the tmux "even-horizontal" look). Debounced so
 * a burst of parallel spawns or staggered exits collapses into a single
 * pass, and non-fatal: a cosmetic resize must never break spawning or
 * watching.
 */
function rebalanceSurfaces(hintPane?: string): void {
  // Prefer the parent pi pane (stable; survives a closing subagent pane).
  const target = process.env.HERDR_PANE_ID ?? hintPane;
  if (!target) return;
  if (rebalanceTimer) clearTimeout(rebalanceTimer);
  rebalanceTimer = setTimeout(() => {
    rebalanceTimer = null;
    void evenSplits(target).catch(() => {
      // Pane/tab may be gone; balancing is best-effort.
    });
  }, 120);
}

async function evenSplits(pane: string): Promise<void> {
  const layout = (await herdrJsonAsync(["pane", "layout", "--pane", pane]))?.layout as
    | LayoutSnapshot
    | undefined;
  if (!layout || layout.zoomed) return;

  for (const step of planEvenSplits(layout)) {
    await herdrJsonAsync([
      "pane",
      "resize",
      "--pane",
      step.pane,
      "--direction",
      step.direction,
      "--amount",
      step.amount.toFixed(4),
    ]);
  }
}

interface ResizeStep {
  pane: string;
  direction: "left" | "right" | "up" | "down";
  amount: number;
}

/**
 * Compute the `pane resize` calls that give every column (for right splits)
 * or row (for down splits) an equal share. For each split the wanted ratio
 * is (columns before the boundary) / (columns in the split). `pane resize`
 * moves the split at the target pane's trailing edge by a ratio delta, so
 * the target is the pane whose trailing edge sits on the boundary.
 * `right`/`down` grow the first side; `left`/`up` shrink it.
 */
export function planEvenSplits(layout: LayoutSnapshot): ResizeStep[] {
  const steps: ResizeStep[] = [];
  const contains = (outer: LayoutRect, inner: LayoutRect) =>
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height;

  for (const split of layout.splits) {
    const horizontal = split.direction === "right";
    const start = (r: LayoutRect) => (horizontal ? r.x : r.y);
    const end = (r: LayoutRect) => (horizontal ? r.x + r.width : r.y + r.height);
    const size = (r: LayoutRect) => (horizontal ? r.width : r.height);

    const inside = layout.panes.filter((p) => contains(split.rect, p.rect));
    if (inside.length < 2) continue;

    const boundary = start(split.rect) + Math.round(size(split.rect) * split.ratio);
    const first = inside.filter((p) => end(p.rect) <= boundary + 1);
    if (first.length === 0 || first.length === inside.length) continue;

    const lanes = (panes: typeof inside) => new Set(panes.map((p) => start(p.rect))).size;
    const wanted = lanes(first) / lanes(inside);
    const delta = wanted - split.ratio;
    if (Math.abs(delta) < 0.01) continue;

    // The pane whose trailing edge lands on the boundary owns this split.
    const target = first.reduce((best, p) => (end(p.rect) > end(best.rect) ? p : best));
    steps.push({
      pane: target.pane_id,
      direction: delta > 0 ? (horizontal ? "right" : "down") : horizontal ? "left" : "up",
      amount: Math.abs(delta),
    });
  }
  return steps;
}

// ── Surface primitives ──

/**
 * Create the surface a subagent runs in.
 *
 * The main session opens a new tab per subagent, so each one is easy to find
 * by name in the tab bar. A subagent spawning its own children splits its
 * pane instead, which keeps a whole lineage inside one tab. Splits go off the
 * parent pi's pane, so new panes follow the agent rather than the user's
 * focus, with the direction taken from the parent pane's geometry (see
 * SUBAGENT_SPLIT_DIRECTION).
 * See https://github.com/HazAT/pi-interactive-subagents/issues/12
 *
 * Returns the new pane id (e.g. `w1:p12`).
 */
export function createSurface(name: string): string {
  requireHerdr();

  if (chooseSurfaceKind() === "tab") {
    const pane = createSurfaceTab(name);
    if (pane) return pane;
    // Tab creation failed (old server, no workspace) — fall back to a split.
  }

  const parent = process.env.HERDR_PANE_ID;
  const direction = chooseSplitDirection(parent ? readLayout(parent) : undefined, parent ?? "");
  return createSurfaceSplit(name, direction, parent);
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Herdr only splits right or down; "left"/"up" map to the same axis.
 * The new pane starts in the caller's cwd and does not take focus unless
 * `options.focus` is set. The pane is labelled with `name` so the Herdr
 * sidebar shows which subagent lives there.
 * Returns the new pane id (e.g. `w1:p12`).
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
  options?: { focus?: boolean; cwd?: string },
): string {
  requireHerdr();

  const args = ["pane", "split"];
  if (fromSurface) {
    args.push(fromSurface);
  } else {
    args.push("--current");
  }
  args.push("--direction", direction === "left" || direction === "right" ? "right" : "down");
  args.push("--cwd", options?.cwd ?? process.cwd());
  args.push(options?.focus ? "--focus" : "--no-focus");

  const result = herdrJson(args);
  const pane = result?.pane?.pane_id;
  // Pane ids are opaque handles (`w1:p12`, `w1:pA`); only trust the JSON shape.
  if (typeof pane !== "string" || pane.trim() === "") {
    throw new Error(`Unexpected herdr pane split output: ${JSON.stringify(result)}`);
  }

  labelSurface(pane, name);
  rebalanceSurfaces(pane);
  return pane;
}

/**
 * Create a new tab holding a single pane for a subagent. The tab carries
 * `name` as its label so the tab bar names the subagent, and the root pane
 * gets the same label for the sidebar. Does not take focus unless
 * `options.focus` is set.
 *
 * Returns the root pane id, or null when Herdr could not create the tab —
 * callers fall back to splitting a pane.
 */
export function createSurfaceTab(
  name: string,
  options?: { focus?: boolean; cwd?: string },
): string | null {
  requireHerdr();

  const args = ["tab", "create"];
  const workspace = process.env.HERDR_WORKSPACE_ID;
  if (workspace) args.push("--workspace", workspace);
  args.push("--cwd", options?.cwd ?? process.cwd());
  const label = name.trim();
  if (label) args.push("--label", label);
  args.push(options?.focus ? "--focus" : "--no-focus");

  let result: any;
  try {
    result = herdrJson(args);
  } catch {
    return null;
  }

  const pane = result?.root_pane?.pane_id;
  if (typeof pane !== "string" || pane.trim() === "") return null;

  labelSurface(pane, name);
  return pane;
}

/**
 * Label a pane in the Herdr sidebar. Cosmetic and best-effort.
 */
export function labelSurface(surface: string, label: string): void {
  const trimmed = label.trim();
  if (!trimmed) return;
  try {
    herdrJson(["pane", "rename", surface, trimmed]);
  } catch {
    // A missing label must never break spawning.
  }
}

/**
 * The tab a pane lives in (e.g. `w1:t2`), or null when it can't be read.
 */
export function getSurfaceTab(surface: string): string | null {
  try {
    const tab = herdrJson(["pane", "get", surface])?.pane?.tab_id;
    return typeof tab === "string" && tab.trim() !== "" ? tab : null;
  } catch {
    return null;
  }
}

/**
 * Get the pane that currently has UI focus in the caller's tab.
 * Returns null when the layout can't be read.
 */
export function getFocusedSurface(fromSurface?: string): string | null {
  const pane = fromSurface ?? process.env.HERDR_PANE_ID;
  if (!pane) return null;
  return readLayout(pane)?.focused_pane_id ?? null;
}

/**
 * Send a command string to a pane and execute it.
 * `pane run` writes the text literally and submits it with Enter as one
 * ordered write, so special characters are never interpreted as keys.
 */
export function sendCommand(surface: string, command: string): void {
  requireHerdr();
  herdrJson(["pane", "run", surface, command]);
}

/**
 * Deliver a message to the agent running in a pane. Goes through the agent
 * surface so Herdr honours bracketed paste and rejects an agent parked at an
 * approval or question dialog (`agent_blocked`) instead of typing over it.
 * Falls back to the raw pane only when Herdr has not recognised an agent in
 * the pane yet (`agent_not_found`), e.g. during startup.
 */
export function sendMessage(surface: string, message: string): void {
  requireHerdr();
  try {
    herdrJson(["agent", "prompt", surface, message]);
  } catch (error: any) {
    if (!/agent_not_found/.test(error?.message ?? "")) throw error;
    sendCommand(surface, message);
  }
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

function readArgs(surface: string, lines: number): string[] {
  return [
    "pane",
    "read",
    surface,
    "--source",
    "recent-unwrapped",
    "--format",
    "text",
    "--lines",
    String(Math.max(1, lines)),
  ];
}

/**
 * Read the screen contents of a pane (sync). `pane read` prints plain text.
 */
export function readScreen(surface: string, lines = 50): string {
  requireHerdr();
  try {
    return execFileSync(herdrBin(), readArgs(surface, lines), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error: any) {
    throw new Error(`herdr pane read failed: ${herdrErrorMessage(error)}`);
  }
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireHerdr();
  try {
    const { stdout } = await execFileAsync(herdrBin(), readArgs(surface, lines), {
      encoding: "utf8",
    });
    return stdout;
  } catch (error: any) {
    throw new Error(`herdr pane read failed: ${herdrErrorMessage(error)}`);
  }
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  requireHerdr();
  herdrJson(["pane", "close", surface]);
  rebalanceSurfaces();
}

// ── Exit polling ──

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way. Clean completions write no
 * sidecar and are detected via the terminal sentinel instead.
 *
 * Note: ask_question does NOT write a `.exit` sidecar — it keeps the session
 * open and signals the parent via a separate `.ask` file (see deliverPendingQuestion).
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };
export const __layoutTest__ = { planEvenSplits, chooseSplitDirection, chooseSurfaceKind };

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by the error path)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
