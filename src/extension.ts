import * as vscode from "vscode";
import { resolveToken } from "./services/auth";
import { fetchUsage, ApiError } from "./services/cursorApi";
import { UsageCache } from "./services/storage";
import type { UsageBucket, UsageData } from "./types/usage";

const MIN_REFRESH_INTERVAL_MS = 30_000;
const TOKEN_PROMPT_COOLDOWN_MS = 60_000;

let statusBarItem: vscode.StatusBarItem;
let pollingTimer: ReturnType<typeof setInterval> | undefined;
let refreshing = false;
let lastRefreshTime = 0;
let tokenPromptShowing = false;
let lastTokenPromptTime = 0;

const cache = new UsageCache();
let log: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  cache.setContext(context);
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

  const openTokenSettingCmd = vscode.commands.registerCommand(
    "cursorMeter.openTokenSetting",
    openTokenSetting,
  );
  context.subscriptions.push(openTokenSettingCmd);

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

/**
 * Token-expiry UX spec:
 * - Missing token and HTTP 401/403 both guide the user to `cursorMeter.sessionToken`.
 * - Polling may record the error, but prompts are rate-limited to avoid spam.
 * - When auth is broken, clicking the status item opens token settings instead of retrying.
 */
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
    if (isTokenAuthError(err)) {
      promptForToken("expired");
    }
  } finally {
    refreshing = false;
    updateStatusBar();
  }
}

// ── Status Bar ───────────────────────────────────────────────────

function showLoading(): void {
  statusBarItem.text = "$(sync~spin) Usage";
  statusBarItem.tooltip = "Refreshing usage…";
}

function updateStatusBar(): void {
  const data = cache.get();
  const error = cache.getError();

  if (data) {
    statusBarItem.text = buildStatusBarText(data);
    statusBarItem.tooltip = buildTooltip(data, error);
    statusBarItem.command = isTokenErrorMessage(error)
      ? "cursorMeter.openTokenSetting"
      : "cursorMeter.refresh";
    statusBarItem.backgroundColor = undefined;
  } else if (error) {
    statusBarItem.text = "$(warning) Usage";
    statusBarItem.tooltip = isTokenErrorMessage(error)
      ? `Error: ${error}\nClick to update WorkosCursorSessionToken`
      : `Error: ${error}\nClick to retry`;
    statusBarItem.command = isTokenErrorMessage(error)
      ? "cursorMeter.openTokenSetting"
      : "cursorMeter.refresh";
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground",
    );
  } else {
    statusBarItem.text = "$(pulse) Usage";
    statusBarItem.tooltip = "Click to load usage";
    statusBarItem.command = "cursorMeter.refresh";
    statusBarItem.backgroundColor = undefined;
  }
}

function buildStatusBarText(data: UsageData): string {
  const days = formatDaysUntilResetShort(data.resetAt);
  const suffix = days ? ` · ${days}` : "";

  if (data.displayMode === "included" && data.includedUsage) {
    if (data.includedUsage.totalCents !== undefined) {
      return `$(pulse) Usage ${formatMoney(data.includedUsage.usedCents)}/${formatMoney(data.includedUsage.totalCents)}${suffix}`;
    }
    return `$(pulse) Usage ${formatMoney(data.includedUsage.usedCents)}${suffix}`;
  }

  if (data.displayMode === "on-demand" && data.onDemandUsage) {
    if (data.onDemandUsage.totalCents !== undefined) {
      return `$(flame) Usage ${formatMoney(data.onDemandUsage.usedCents)}/${formatMoney(data.onDemandUsage.totalCents)}${suffix}`;
    }
    return `$(flame) Usage ${formatMoney(data.onDemandUsage.usedCents)}${suffix}`;
  }

  if (data.displayMode === "requests" && data.requestsUsage) {
    return `$(pulse) Usage ${data.requestsUsage.used}/${data.requestsUsage.total}${suffix}`;
  }

  return `$(calendar) Usage ${formatResetShort(data.resetAt)}`;
}

function buildTooltip(
  data: UsageData,
  error: string | undefined,
): vscode.MarkdownString {
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
      `| Requests | ${data.requestsUsage.used} / ${data.requestsUsage.total} |`,
    );
  }

  const todayPieces: string[] = [];
  if (data.todayRequests && data.todayRequests > 0) {
    todayPieces.push(`${data.todayRequests} requests`);
  }
  if (data.todayCostCents && data.todayCostCents > 0) {
    todayPieces.push(formatMoney(data.todayCostCents));
  }
  if (todayPieces.length > 0) {
    lines.push(`| Today's Usage | ${todayPieces.join(" / ")} |`);
  }

  lines.push(
    `| Resets | ${formatResetLong(data.resetAt)} |`,
  );

  const daysLine = formatDaysUntilResetLine(data.resetAt);
  if (daysLine) {
    lines.push(`| Days until reset | ${daysLine} |`);
  }

  const pace = buildRoughDailyPaceLine(data);
  if (pace) {
    lines.push(`| Pace (rough) | ${pace} |`);
  }

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
  const current = meterConfig.inspect<number>("refreshIntervalMinutes");
  const legacy = legacyConfig.inspect<number>("refreshIntervalMinutes");
  const minutes =
    current?.workspaceValue ??
    current?.globalValue ??
    legacy?.workspaceValue ??
    legacy?.globalValue ??
    5;
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

function isTokenAuthError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403);
}

function isTokenErrorMessage(message: string | undefined): boolean {
  return message?.startsWith("Token expired or invalid") === true ||
    message === "No token configured";
}

function promptForToken(reason: "missing" | "expired" = "missing"): void {
  const now = Date.now();
  if (
    tokenPromptShowing ||
    now - lastTokenPromptTime < TOKEN_PROMPT_COOLDOWN_MS
  ) {
    return;
  }

  tokenPromptShowing = true;
  lastTokenPromptTime = now;
  const message = reason === "expired"
    ? "Cursor Meter: WorkosCursorSessionToken expired or invalid. Update it to refresh usage."
    : "Cursor Meter: No session token found. Configure it in settings or enable auto-read.";

  vscode.window
    .showWarningMessage(
      message,
      "Open Token Setting",
      "Open Cursor Settings",
    )
    .then((choice) => {
      tokenPromptShowing = false;
      if (choice === "Open Token Setting") {
        openTokenSetting();
      } else if (choice === "Open Cursor Settings") {
        vscode.env.openExternal(vscode.Uri.parse("https://cursor.com/settings"));
      }
    }, () => {
      tokenPromptShowing = false;
    });
}

function openTokenSetting(): void {
  vscode.commands.executeCommand(
    "workbench.action.openSettings",
    "cursorMeter.sessionToken",
  );
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

/** Full calendar days from now until reset (ceil); undefined if unknown. */
function daysUntilReset(resetAt: string | undefined): number | undefined {
  if (!resetAt) {
    return undefined;
  }
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  const ms = date.getTime() - Date.now();
  if (ms <= 0) {
    return 0;
  }
  return Math.ceil(ms / 86_400_000);
}

function formatDaysUntilResetShort(resetAt: string | undefined): string {
  const d = daysUntilReset(resetAt);
  if (d === undefined) {
    return "";
  }
  if (d === 0) {
    return "0d";
  }
  return `${d}d`;
}

function formatDaysUntilResetLine(resetAt: string | undefined): string {
  const d = daysUntilReset(resetAt);
  if (d === undefined) {
    return "";
  }
  if (d === 0) {
    return "today / overdue window";
  }
  if (d === 1) {
    return "1 day";
  }
  return `${d} days`;
}

/**
 * Naive “budget ÷ days left” hint for pacing — not official Cursor billing.
 */
function buildRoughDailyPaceLine(data: UsageData): string {
  const days = daysUntilReset(data.resetAt);
  if (days === undefined || days <= 0) {
    return "";
  }

  const denom = Math.max(1, days);

  if (
    data.paceTotalCapCents !== undefined &&
    data.paceUsedCents !== undefined &&
    data.paceTotalCapCents > 0
  ) {
    const remaining = data.paceTotalCapCents - data.paceUsedCents;
    if (remaining <= 0) {
      return "";
    }
    const perDay = remaining / denom;
    return `~${formatMoney(Math.round(perDay))}/day (${formatMoney(remaining)} ÷ ${denom}d, cap ${formatMoney(data.paceTotalCapCents)} = budget + hard limit)`;
  }

  const tryBucket = (bucket: UsageBucket | undefined): string => {
    if (!bucket?.totalCents) {
      return "";
    }
    const remaining = bucket.totalCents - bucket.usedCents;
    if (remaining <= 0) {
      return "";
    }
    const perDay = remaining / denom;
    return `~${formatMoney(Math.round(perDay))}/day on remaining cap (${formatMoney(remaining)} ÷ ${denom}d)`;
  };

  if (data.displayMode === "on-demand" && data.onDemandUsage) {
    const line = tryBucket(data.onDemandUsage);
    if (line) {
      return line;
    }
  }
  if (data.includedUsage?.totalCents !== undefined) {
    const line = tryBucket(data.includedUsage);
    if (line) {
      return line;
    }
  }
  if (data.onDemandUsage) {
    const line = tryBucket(data.onDemandUsage);
    if (line) {
      return line;
    }
  }
  return "";
}
