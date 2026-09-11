import type { DeliveryEvent } from "./types.js";
import { IncidentService } from "./service.js";

export function startTimerScanner(
  service: IncidentService,
  dispatch: (events: readonly DeliveryEvent[]) => Promise<void>,
  intervalMs = 5_000,
): () => void {
  const timer = setInterval(() => {
    const events = service.scanDue();
    if (events.length > 0) {
      void dispatch(events);
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
