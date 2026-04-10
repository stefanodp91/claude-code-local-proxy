/**
 * health-checker.ts — Polls the proxy /health endpoint.
 *
 * Emits connection status changes via a callback.
 *
 * @module extension/proxy
 */

import { ConnectionStatus } from "../../shared/message-protocol";

const POLL_INTERVAL_MS = 10_000;

export class HealthChecker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentStatus = ConnectionStatus.Disconnected;

  constructor(
    private readonly baseUrl: string,
    private readonly onStatusChange: (status: ConnectionStatus) => void,
  ) {}

  start(): void {
    this.check();
    this.timer = setInterval(() => this.check(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  updateBaseUrl(baseUrl: string): void {
    (this as any).baseUrl = baseUrl;
  }

  private async check(): Promise<void> {
    const prev = this.currentStatus;
    this.currentStatus = ConnectionStatus.Checking;

    if (prev !== ConnectionStatus.Checking) {
      this.onStatusChange(ConnectionStatus.Checking);
    }

    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        this.currentStatus = ConnectionStatus.Connected;
      } else {
        this.currentStatus = ConnectionStatus.Disconnected;
      }
    } catch {
      this.currentStatus = ConnectionStatus.Disconnected;
    }

    this.onStatusChange(this.currentStatus);
  }
}
