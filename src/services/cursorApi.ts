import type {
  CursorPlan,
  RequestsUsage,
  UsageBucket,
  UsageData,
} from "../types/usage";
import type { OutputChannel } from "vscode";

const API_BASE = "https://cursor.com/api";
const REQUEST_TIMEOUT_MS = 15_000;

const INCLUDED_BUDGET_CENTS: Partial<Record<CursorPlan, number>> = {
  pro: 2_000,
  pro_plus: 7_000,
  ultra: 40_000,
  team: 2_000,
};

// ── Public entry point ──────────────────────────────────────────────

export async function fetchUsage(
  token: string,
  log: OutputChannel,
): Promise<UsageData> {
  log.appendLine("[api] Starting fetch...");

  const { encodedToken, userId } = buildTokenContext(token);

  const usageRaw = (await requestJson(
    `${API_BASE}/usage?user=${userId ?? "true"}`,
    encodedToken,
    log,
  )) as Record<string, unknown>;

  const stripeRaw = await requestOptionalJson(
    `${API_BASE}/auth/stripe`,
    encodedToken,
    log,
  );

  const billingStart = extractBillingStart(usageRaw);
  const plan = detectPlan(usageRaw, stripeRaw);

  const events = await fetchUsageEvents(encodedToken, billingStart, log);
  const numericUserId = findNumericUserId(events);

  const teamSpendRaw = await fetchTeamSpend(encodedToken, stripeRaw, log);
  const myMember = findCurrentUserMember(teamSpendRaw, numericUserId, log);

  log.appendLine(
    `[api] plan=${plan}, events=${events.length}, hasTeamData=${myMember !== undefined}`,
  );
  if (myMember) {
    log.appendLine(
      `[api] myMember keys: ${Object.keys(myMember).join(", ") || "(none)"}`,
    );
    log.appendLine(`[api] myMember raw: ${previewJson(redactForLog(myMember), 3000)}`);
  }
  log.appendLine(
    `[api] teamSpend summary: ${previewJson(redactForLog(pickSummaryFields(teamSpendRaw)), 2000)}`,
  );

  const data = buildUsageData(plan, myMember, teamSpendRaw, usageRaw, events, billingStart, log);
  return data;
}

// ── Token context ───────────────────────────────────────────────────

function buildTokenContext(token: string): {
  encodedToken: string;
  userId: string | undefined;
} {
  const encodedToken = token.includes("::")
    ? token.replace("::", "%3A%3A")
    : token;
  const match = token.match(/^(user_[A-Za-z0-9]+)/);
  return { encodedToken, userId: match?.[1] };
}

// ── Find current user in team spend ─────────────────────────────────

function findNumericUserId(events: unknown[]): string | undefined {
  for (const event of events) {
    if (!isRecord(event)) {
      continue;
    }
    if (typeof event["owningUser"] === "string") {
      return event["owningUser"];
    }
    if (typeof event["owningUser"] === "number") {
      return String(event["owningUser"]);
    }
  }
  return undefined;
}

function findCurrentUserMember(
  teamSpendRaw: Record<string, unknown>,
  numericUserId: string | undefined,
  log: OutputChannel,
): Record<string, unknown> | undefined {
  const members = teamSpendRaw["teamMemberSpend"];
  if (!Array.isArray(members)) {
    return undefined;
  }

  if (numericUserId) {
    const numId = Number(numericUserId);
    const match = members.find(
      (m) => isRecord(m) && (m["userId"] === numId || String(m["userId"]) === numericUserId),
    );
    if (isRecord(match)) {
      log.appendLine("[api] Matched current user in team spend data");
      return match;
    }
  }

  // If team has only one member in current page, use it as a safe fallback.
  // This avoids falling back to charged-event sums when userId cannot be inferred.
  if (members.length === 1 && isRecord(members[0])) {
    log.appendLine("[api] Using single team member as fallback");
    return members[0];
  }

  log.appendLine(
    `[api] Could not match current user in ${members.length} team members`,
  );
  return undefined;
}

// ── Data assembly ───────────────────────────────────────────────────

function buildUsageData(
  plan: CursorPlan,
  myMember: Record<string, unknown> | undefined,
  teamSpendRaw: Record<string, unknown>,
  usageRaw: Record<string, unknown>,
  events: unknown[],
  billingStart: Date,
  log: OutputChannel,
): UsageData {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const eventTotals = sumEventCosts(events, startOfToday.getTime());

  const rawIncludedSpendCents = asNumber(myMember?.["includedSpendCents"]);
  const rawSpendCents = asNumber(myMember?.["spendCents"]);
  const topLevelMaxUserSpendCents = asNumber(teamSpendRaw["maxUserSpendCents"]);
  const topLevelLimitedUserCount = asNumber(teamSpendRaw["limitedUserCount"]);

  // Team summary semantics (aligned with observed account behavior):
  // - spendCents tracks billed on-demand usage
  // - once on-demand > 0, included budget is effectively exhausted (20/20 for team)
  const hasSummary =
    rawIncludedSpendCents !== undefined || rawSpendCents !== undefined;
  const source = hasSummary ? "get-team-spend" : "chargedCents-sum";

  const budgetCents = INCLUDED_BUDGET_CENTS[plan] ?? 0;

  const effectiveLimitDollars = asNumber(myMember?.["effectivePerUserLimitDollars"]);
  const hardLimitOverrideDollars = asNumber(myMember?.["hardLimitOverrideDollars"]);
  const onDemandLimitCents =
    effectiveLimitDollars !== undefined && effectiveLimitDollars > 0
      ? effectiveLimitDollars * 100
      : undefined;

  const totalSpent = rawIncludedSpendCents ?? eventTotals.chargedCents;
  const onDemandSpent = rawSpendCents ?? Math.max(totalSpent - budgetCents, 0);
  const includedSpent =
    onDemandSpent > 0
      ? budgetCents
      : Math.min(rawIncludedSpendCents ?? totalSpent, budgetCents);

  let paceTotalCapCents: number | undefined;
  let paceUsedCents: number | undefined;
  if (
    budgetCents > 0 &&
    hardLimitOverrideDollars !== undefined &&
    hardLimitOverrideDollars > 0
  ) {
    paceTotalCapCents = budgetCents + Math.round(hardLimitOverrideDollars * 100);
    paceUsedCents = includedSpent + onDemandSpent;
  }

  log.appendLine(
    `[api] raw member values: includedSpendCents=${rawIncludedSpendCents ?? "n/a"}¢, spendCents=${rawSpendCents ?? "n/a"}¢, effectivePerUserLimitDollars=${effectiveLimitDollars ?? "n/a"}, hardLimitOverrideDollars=${hardLimitOverrideDollars ?? "n/a"}, maxUserSpendCents=${topLevelMaxUserSpendCents ?? "n/a"}¢, limitedUserCount=${topLevelLimitedUserCount ?? "n/a"}`,
  );
  log.appendLine(
    `[api] computed values: budget=${budgetCents}¢, totalSpent=${totalSpent}¢, included=${includedSpent}¢, onDemand=${onDemandSpent}¢, onDemandLimit=${onDemandLimitCents ?? "n/a"}¢ (source=${source})`,
  );

  const resetAt = detectResetDate(myMember, teamSpendRaw, billingStart);

  let includedUsage: UsageBucket | undefined;
  let onDemandUsage: UsageBucket | undefined;

  if (budgetCents > 0 || includedSpent > 0) {
    includedUsage = {
      usedCents: includedSpent,
      totalCents: budgetCents > 0 ? budgetCents : undefined,
      source,
    };
  }
  if (onDemandSpent > 0) {
    onDemandUsage = {
      usedCents: onDemandSpent,
      totalCents: onDemandLimitCents,
      source,
    };
  }

  const requestsUsage = extractRequestsUsage(usageRaw);
  const displayMode = pickDisplayMode(includedUsage, onDemandUsage, requestsUsage);

  return {
    plan,
    includedUsage,
    onDemandUsage,
    requestsUsage,
    resetAt: resetAt.toISOString(),
    fetchedAt: Date.now(),
    displayMode,
    paceTotalCapCents,
    paceUsedCents,
    todayCostCents: eventTotals.todayCents > 0 ? eventTotals.todayCents : undefined,
  };
}


function detectResetDate(
  myMember: Record<string, unknown> | undefined,
  teamSpendRaw: Record<string, unknown>,
  fallback: Date,
): Date {
  for (const src of [myMember ?? {}, teamSpendRaw]) {
    for (const key of [
      "nextCycleStart",
      "subscriptionCycleEnd",
      "billingCycleEnd",
    ]) {
      const raw = src[key];
      if (typeof raw === "string") {
        const d = new Date(raw);
        if (!Number.isNaN(d.getTime()) && d.getTime() > Date.now()) {
          return d;
        }
      }
    }
  }
  const resetAt = new Date(fallback);
  resetAt.setMonth(resetAt.getMonth() + 1);
  return resetAt;
}

function detectPlan(
  usageRaw: Record<string, unknown>,
  stripeRaw: Record<string, unknown>,
): CursorPlan {
  if (stripeRaw["isTeamMember"] === true) {
    return "team";
  }
  const membershipType = (
    (stripeRaw["membershipType"] as string | undefined) ||
    (stripeRaw["individualMembershipType"] as string | undefined) ||
    ""
  ).toLowerCase();
  switch (membershipType) {
    case "pro":
    case "hobby":
      return "pro";
    case "pro_plus":
      return "pro_plus";
    case "ultra":
      return "ultra";
    case "free":
    case "free_trial":
      return "free";
  }
  const gpt4 = isRecord(usageRaw["gpt-4"]) ? usageRaw["gpt-4"] : undefined;
  if (
    gpt4 &&
    typeof gpt4["maxRequestUsage"] === "number" &&
    gpt4["maxRequestUsage"] > 0
  ) {
    return "pro";
  }
  return "unknown";
}

function extractBillingStart(usageRaw: Record<string, unknown>): Date {
  const raw = usageRaw["startOfMonth"];
  if (typeof raw === "string") {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) {
      return d;
    }
  }
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

function extractRequestsUsage(
  usageRaw: Record<string, unknown>,
): RequestsUsage | undefined {
  const gpt4 = isRecord(usageRaw["gpt-4"]) ? usageRaw["gpt-4"] : undefined;
  if (
    gpt4 &&
    typeof gpt4["maxRequestUsage"] === "number" &&
    gpt4["maxRequestUsage"] > 0
  ) {
    return {
      used: typeof gpt4["numRequests"] === "number" ? gpt4["numRequests"] : 0,
      total: gpt4["maxRequestUsage"],
      source: "premium",
    };
  }
  return undefined;
}

function sumEventCosts(events: unknown[], startOfTodayMs: number): {
  chargedCents: number;
  todayCents: number;
} {
  let chargedCents = 0;
  let todayCents = 0;
  for (const event of events) {
    if (!isRecord(event)) {
      continue;
    }
    if (typeof event["chargedCents"] === "number") {
      chargedCents += event["chargedCents"];
      if (getEventTimestamp(event) >= startOfTodayMs) {
        todayCents += event["chargedCents"];
      }
    }
  }
  return { chargedCents: Math.round(chargedCents), todayCents: Math.round(todayCents) };
}

function getEventTimestamp(event: Record<string, unknown>): number {
  for (const key of ["timestamp", "date", "createdAt", "created_at"]) {
    const val = event[key];
    if (typeof val === "string" || typeof val === "number") {
      const ms = new Date(val).getTime();
      if (!Number.isNaN(ms)) return ms;
    }
  }
  return 0; // fallback if no recognizable timestamp
}

function pickDisplayMode(
  includedUsage: UsageBucket | undefined,
  onDemandUsage: UsageBucket | undefined,
  requestsUsage: RequestsUsage | undefined,
): UsageData["displayMode"] {
  if (includedUsage) {
    if (
      includedUsage.totalCents === undefined ||
      includedUsage.usedCents < includedUsage.totalCents
    ) {
      return "included";
    }
  }
  if (onDemandUsage && onDemandUsage.usedCents > 0) {
    return "on-demand";
  }
  if (requestsUsage && requestsUsage.used < requestsUsage.total) {
    return "requests";
  }
  return "reset";
}

// ── HTTP helpers ────────────────────────────────────────────────────

async function fetchUsageEvents(
  encodedToken: string,
  since: Date,
  log: OutputChannel,
): Promise<unknown[]> {
  try {
    const raw = await requestJsonPost(
      `${API_BASE}/dashboard/get-filtered-usage-events`,
      encodedToken,
      {
        teamId: 0,
        startDate: since.getTime().toString(),
        endDate: Date.now().toString(),
        page: 1,
        pageSize: 100,
      },
      log,
    );
    if (isRecord(raw) && Array.isArray(raw["usageEventsDisplay"])) {
      return raw["usageEventsDisplay"] as unknown[];
    }
    return [];
  } catch (err) {
    log.appendLine(
      `[api] events fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

async function fetchTeamSpend(
  encodedToken: string,
  stripeRaw: Record<string, unknown>,
  log: OutputChannel,
): Promise<Record<string, unknown>> {
  if (stripeRaw["isTeamMember"] !== true) {
    return {};
  }
  const teamId = stripeRaw["teamId"];
  if (typeof teamId !== "number") {
    return {};
  }
  try {
    const raw = await requestJsonPost(
      `${API_BASE}/dashboard/get-team-spend`,
      encodedToken,
      { teamId, page: 1, pageSize: 200, sortBy: "name", sortDirection: "asc" },
      log,
    );
    return isRecord(raw) ? raw : {};
  } catch (err) {
    log.appendLine(
      `[api] get-team-spend failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
}

async function requestJson(
  url: string,
  encodedToken: string,
  _log: OutputChannel,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: buildHeaders(encodedToken),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ApiError(res.status, body);
    }
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

async function requestJsonPost(
  url: string,
  encodedToken: string,
  body: Record<string, unknown>,
  _log: OutputChannel,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { ...buildHeaders(encodedToken), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const resBody = await res.text().catch(() => "");
      throw new ApiError(res.status, resBody);
    }
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

async function requestOptionalJson(
  url: string,
  encodedToken: string,
  log: OutputChannel,
): Promise<Record<string, unknown>> {
  try {
    const raw = await requestJson(url, encodedToken, log);
    return isRecord(raw) ? raw : {};
  } catch (err) {
    if (err instanceof ApiError) {
      log.appendLine(`[api] Optional endpoint failed: HTTP ${err.status}`);
    } else {
      log.appendLine(
        `[api] Optional endpoint failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return {};
  }
}

function buildHeaders(encodedToken: string): Record<string, string> {
  return {
    Cookie: `WorkosCursorSessionToken=${encodedToken}`,
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "application/json",
    Origin: "https://cursor.com",
    Referer: "https://cursor.com/dashboard",
  };
}

// ── Utilities ───────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? Math.round(value) : undefined;
}

function previewJson(raw: unknown, limit = 800): string {
  try {
    const text = JSON.stringify(raw);
    return text.length <= limit
      ? text
      : `${text.slice(0, limit)}…[+${text.length - limit}]`;
  } catch {
    return "[unserializable]";
  }
}

function redactForLog(raw: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...raw };
  for (const key of ["name", "email", "token", "sessionToken"]) {
    if (key in copy) {
      copy[key] = "[redacted]";
    }
  }
  return copy;
}

function pickSummaryFields(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const keys = [
    "subscriptionCycleStart",
    "nextCycleStart",
    "maxUserSpendCents",
    "limitedUserCount",
    "totalMembers",
    "totalPages",
    "hasAnySpendLimitOverrides",
    "hasAnyFreeUsage",
  ];
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in raw) {
      out[key] = raw[key];
    }
  }
  return out;
}

// ── Errors ──────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`API responded with ${status}`);
    this.name = "ApiError";
  }
}
