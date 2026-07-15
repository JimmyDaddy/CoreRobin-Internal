import type { HealthStateSnapshot, HealthStateUpdate } from "./healthState";

type PublishHealthState = (
  update: HealthStateUpdate,
) => Promise<HealthStateSnapshot>;

export class HealthStatePublisher {
  private queued: HealthStateUpdate | null = null;
  private publishing = false;
  private disposed = false;

  constructor(private readonly publishState: PublishHealthState) {}

  publish(update: HealthStateUpdate): void {
    if (this.disposed) return;
    this.queued = update;
    void this.drain();
  }

  dispose(): void {
    this.disposed = true;
    this.queued = null;
  }

  private async drain(): Promise<void> {
    if (this.publishing || this.disposed) return;
    this.publishing = true;
    try {
      while (!this.disposed && this.queued) {
        const update = this.queued;
        this.queued = null;
        try {
          await this.publishState(update);
        } catch {
          // Keep the newest pending state for a later sample to retry. Do not
          // spin on IPC failures or let an older failed update replace it.
          this.queued ??= update;
          break;
        }
      }
    } finally {
      this.publishing = false;
    }
  }
}
