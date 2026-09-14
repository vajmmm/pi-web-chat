import { useEffect, useState } from "react";

/**
 * Returns true once `active` has been true at least once (and keeps returning
 * true while `active` is true). Use it to defer mounting — and therefore
 * lazily importing — heavy dialog/drawer components until they are first
 * opened, while keeping them mounted afterwards so their exit animations and
 * internal state survive closing.
 */
export function useMountedOnce(active: boolean): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (active) setMounted(true);
  }, [active]);
  return mounted || active;
}
