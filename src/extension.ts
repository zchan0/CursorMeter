import * as vscode from "vscode";
import { resolveToken } from "./services/auth";
import { fetchUsage, ApiError } from "./services/cursorApi";
import { UsageCache } from "./services/storage";
import type { UsageBucket, UsageData } from "./types/usage";

const MIN_REFRESH_INTERVAL_MS = 30_000;

let statusBarItem: vscode.StatusBarItem;
let pollingTimer: ReturnType<typeof setInterval> | undefined;
let refreshing = false;
let lastRefreshTime = 0;

const cache = new UsageCache();
let log: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  log = vscode.window.createOutputChannel("Cursor Meter");
  log.appendLine("Cursor Meter activated");

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.command = "cursorMeter.refresh";
  statusBarItem.name = "Cursor Meter";
  context.subscriptions.push(statusBarItem);

  const refreshCmd = vscode.commands.registerCommand(
    "cursorMeter.refresh",
    () => refresh(true),
  );
  context.subscriptions.push(refreshCmd);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("cursorMeter") ||
        e.affectsConfiguration("cursorUsage")
      ) {
        restartPolling();
        refresh();
      }
    }),
  );

  updateStatusBar();
  statusBarItem.show();
  refresh();
  startPolling();
}

export function deactivate(): void {
  stopPolling();
}

// ── Refresh ──────────────────────────────────────────────────────

async function refresh(manual = false): Promise<void> {
  if (refreshing) {
    return;
  }

  const now = Date.now();
  if (!manual && now - lastRefreshTime < MIN_REFRESH_INTERVAL_MS) {
    log.appendLine("[refresh] Throttled — too soon since last refresh");
    return;
  }

  refreshing = true;
  lastRefreshTime = now;
  showLoading();

  try {
    const token = await resolveToken(log);
    if (!token) {
      cache.setError("No token configured");
      updateStatusBar();
      promptForToken();
      return;
    }

    const data = await fetchUsage(token, log);
    cache.set(data);
  } catch (err: unknown) {
    const msg = formatError(err);
    log.appendLine(`[refresh] Error: ${msg}`);
    cache.setError(msg);
  } finally {
    refreshing = false;
    updateStatusBar();
  }
}

// ── Status Bar ───────────────────────────────────────────────────

function showLoading(): void {
  statusBarItem.text = "$(sync~spin) Cursor";
  statusBarItem.tooltip = "Refreshing usage…";
}

function updateStatusBar(): void {
  const data = cache.get();
  const error = cache.getError();

  if (data) {
    statusBarItem.text = buildStatusBarText(data);
    statusBarItem.tooltip = buildTooltip(data, error);
    statusBarItem.backgroundColor = undefined;
  } else if (error) {
    statusBarItem.text = "$(warning) Cursor";
    statusBarItem.tooltip = `Error: ${error}\nClick to retry`;
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground",
    );
  } else {
    statusBarItem.text = "$(pulse) Cursor";
    statusBarItem.tooltip = "Click to load usage";
    statusBarItem.backgroundColor = undefined;
  }
}

function buildStatusBarText(data: UsageData): string {
  if (data.displayMode === "included" && data.includedUsage) {
    if (data.includedUsage.totalCents !== undefined) {
      return `$(pulse) Cursor ${formatMoney(data.includedUsage.usedCents)}/${formatMoney(data.includedUsage.totalCents)}`;
    }
    return `$(pulse) Cursor ${formatMoney(data.includedUsage.usedCents)}`;
  }

  if (data.displayMode === "on-demand" && data.onDemandUsage) {
    if (data.onDemandUsage.totalCents !== undefined) {
      return `$(flame) Cursor ${formatMoney(data.onDemandUsage.usedCents)}/${formatMoney(data.onDemandUsage.totalCents)}`;
    }
    return `$(flame) Cursor ${formatMoney(data.onDemandUsage.usedCents)}`;
  }

  if (data.displayMode === "requests" && data.requestsUsage) {
    return `$(pulse) Cursor ${data.requestsUsage.used}/${data.requestsUsage.total}`;
  }

  return `$(calendar) Cursor ${formatResetShort(data.resetAt)}`;
}

function buildTooltip(
  data: UsageData,
  error: string | undefined,
): vscode.MarkdownString {
  const ago = timeAgo(data.fetchedAt);
  const lines = [`**Cursor Meter** (${formatPlan(data.plan)})`, ""];

  lines.push(`| | |`, `|---|---|`);

  if (data.includedUsage) {
    lines.push(
      `| Included usage | ${formatBucket(data.includedUsage)} |`,
    );
  }

  if (data.onDemandUsage) {
    lines.push(
      `| On-Demand usage | ${formatBucket(data.onDemandUsage)} |`,
    );
  }

  if (data.requestsUsage) {
    lines.push(
      `| Requests | ${data.requestsUsage.used} / ${data.requestsUsage.total} (${data.requestsUsage.source}) |`,
    );
  }

  lines.push(
    `| Resets | ${formatResetLong(data.resetAt)} |`,
    `| Last updated | ${ago} |`,
  );

  if (error) {
    lines.push("", `$(warning) Last error: ${error}`);
  }

  lines.push("", "_Click to refresh_");

  const md = new vscode.MarkdownString(lines.join("\n"));
  md.isTrusted = true;
  md.supportThemeIcons = true;
  return md;
}

// ── Polling ──────────────────────────────────────────────────────

function getIntervalMs(): number {
  const meterConfig = vscode.workspace.getConfiguration("cursorMeter");
  const legacyConfig = vscode.workspace.getConfiguration("cursorUsage");
  const minutes = meterConfig.get<number>(
    "refreshIntervalMinutes",
    legacyConfig.get<number>("refreshIntervalMinutes", 5),
  );
  return Math.max(1, minutes) * 60_000;
}

function startPolling(): void {
  stopPolling();
  pollingTimer = setInterval(() => refresh(), getIntervalMs());
}

function stopPolling(): void {
  if (pollingTimer !== undefined) {
    clearInterval(pollingTimer);
    pollingTimer = undefined;
  }
}

function restartPolling(): void {
  startPolling();
}

// ── Helpers ──────────────────────────────────────────────────────

function formatError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) {
      return "Token expired or invalid (HTTP " + err.status + ")";
    }
    return `API error (HTTP ${err.status})`;
  }
  if (err instanceof Error) {
    if (err.name === "AbortError") {
      return "Request timed out";
    }
    return err.message;
  }
  return String(err);
}

function promptForToken(): void {
  vscode.window
    .showWarningMessage(
      "Cursor Meter: No session token found. Configure it in settings or enable auto-read.",
      "Open Settings",
    )
    .then((choice) => {
      if (choice === "Open Settings") {
        vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "cursorMeter",
        );
      }
    });
}

function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatBucket(bucket: UsageBucket): string {
  if (bucket.totalCents !== undefined) {
    return `${formatMoney(bucket.usedCents)} / ${formatMoney(bucket.totalCents)}`;
  }
  return formatMoney(bucket.usedCents);
}

function formatMoney(cents: number): string {
  const dollars = cents / 100;
  return dollars >= 100 ? `$${dollars.toFixed(0)}` : `$${dollars.toFixed(2)}`;
}

function formatPlan(plan: UsageData["plan"]): string {
  switch (plan) {
    case "team":
      return "Team";
    case "pro":
      return "Pro";
    case "pro_plus":
      return "Pro Plus";
    case "ultra":
      return "Ultra";
    case "free":
      return "Free";
    default:
      return "Unknown";
  }
}

function formatResetShort(resetAt: string | undefined): string {
  if (!resetAt) {
    return "resets soon";
  }
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) {
    return "resets soon";
  }
  return `Reset ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

function formatResetLong(resetAt: string | undefined): string {
  if (!resetAt) {
    return "Unknown";
  }
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
