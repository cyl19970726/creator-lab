export function startLeaseHeartbeat(task: () => Promise<void>, onFailure: (error: unknown) => void = () => {}): { stop(): Promise<void> } {
  let stopped = false;
  let active: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (stopped || active) return;
    active = Promise.resolve().then(task).catch((error: unknown) => {
      try { onFailure(error); } catch { /* Preserve the original worker failure path. */ }
    }).finally(() => { active = null; });
  }, 20_000);
  return { async stop() {
    stopped = true;
    clearInterval(timer);
    if (active) await active;
  } };
}
