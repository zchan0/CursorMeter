export interface UsageBucket {
  usedCents: number;
  totalCents?: number;
  source: string;
}

export interface RequestsUsage {
  used: number;
  total: number;
  source: "premium" | "trial";
}

export type CursorPlan = "free" | "pro" | "pro_plus" | "ultra" | "team" | "unknown";

export interface UsageData {
  plan: CursorPlan;
  includedUsage?: UsageBucket;
  onDemandUsage?: UsageBucket;
  requestsUsage?: RequestsUsage;
  resetAt?: string;
  fetchedAt: number;
  displayMode: "included" | "on-demand" | "requests" | "reset";
  /**
   * Rough pace hint: combined cycle cap = included budget (¢) + hardLimitOverrideDollars (→¢).
   * Only set when team/API provides hardLimitOverrideDollars.
   */
  paceTotalCapCents?: number;
  /** Combined used (included + on-demand) in cents, aligned with status display. */
  paceUsedCents?: number;
}
