import * as vscode from "vscode";
import type { UsageData } from "../types/usage";

const TODAY_BASE_PREFIX = "cursorUsageBase_";

function getTodayKey(): string {
  const d = new Date();
  return `${TODAY_BASE_PREFIX}${d.getFullYear()}_${d.getMonth() + 1}_${d.getDate()}`;
}

/**
 * Simple in-memory cache for the last successful usage fetch.
 * Also tracks the initial usage value for today to calculate delta.
 */
export class UsageCache {
  private data: UsageData | undefined;
  private lastError: string | undefined;
  private ctx: vscode.ExtensionContext | undefined;

  setContext(ctx: vscode.ExtensionContext) {
    this.ctx = ctx;
  }

  get(): UsageData | undefined {
    return this.data;
  }

  set(data: UsageData): void {
    if (this.ctx) {
      this.enrichWithTodayUsage(data, this.ctx);
    }
    this.data = data;
    this.lastError = undefined;
  }

  private enrichWithTodayUsage(data: UsageData, ctx: vscode.ExtensionContext): void {
    const key = getTodayKey();
    
    // Structure: { requestsUsed: number, paceUsedCents: number }
    const storedBase = ctx.globalState.get<{ requestsUsed: number; paceUsedCents: number }>(key);
    
    const currentRequests = data.requestsUsage?.used ?? 0;
    const currentCents = data.paceUsedCents ?? 0;

    if (!storedBase) {
      // First time we run today, set base line to current usage.
      // E.g., if user already made 10 requests today before opening vscode, today delta is 0
      // but it will grow as they use it.
      ctx.globalState.update(key, { requestsUsed: currentRequests, paceUsedCents: currentCents });
      data.todayRequests = 0;
      data.todayCostCents = 0;
    } else {
      data.todayRequests = Math.max(0, currentRequests - storedBase.requestsUsed);
      data.todayCostCents = Math.max(0, currentCents - storedBase.paceUsedCents);
    }

    // Clean up old keys asynchronously so globalState doesn't grow forever
    setTimeout(() => {
      const keys = ctx.globalState.keys();
      for (const k of keys) {
        if (k.startsWith(TODAY_BASE_PREFIX) && k !== key) {
          ctx.globalState.update(k, undefined);
        }
      }
    }, 10_000);
  }

  setError(message: string): void {
    this.lastError = message;
  }

  getError(): string | undefined {
    return this.lastError;
  }

  clear(): void {
    this.data = undefined;
    this.lastError = undefined;
  }
}
