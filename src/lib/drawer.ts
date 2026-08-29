const listeners = new Set<() => void>();

export function requestOpenSessionsDrawer() {
  for (const l of listeners) l();
}

export function onRequestOpenSessionsDrawer(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
