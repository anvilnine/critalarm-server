// The steps that must wait for the listener. The relay calls back to BASE_URL
// while it registers this server, and a due timer may forward to the relay, so
// neither runs before the server accepts connections. Registration starts first
// and runs in the background; the scan of due timers runs right after it starts.
export async function runAfterListen(
  listen: (onListening: () => void) => void,
  steps: { register?: () => Promise<void>; scanDue: () => Promise<void> },
): Promise<void> {
  await new Promise<void>((resolve) => { listen(resolve); });
  if (steps.register !== undefined) void steps.register().catch(() => undefined);
  await steps.scanDue();
}
