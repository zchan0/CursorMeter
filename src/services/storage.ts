import type { UsageData } from "../types/usage";

/**
 * Simple in-memory cache for the last successful usage fetch.
 * Persisting across sessions is not critical for MVP.
 */
export class UsageCache {
  private data: UsageData | undefined;
  private lastError: string | undefined;

  get(): UsageData | undefined {
    return this.data;
  }

  set(data: UsageData): void {
    this.data = data;
    this.lastError = undefined;
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
