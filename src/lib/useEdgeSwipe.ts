import { useEffect } from "react";

interface EdgeSwipeOptions {
  enabled?: boolean;
  edgeSize?: number;
  threshold?: number;
  onSwipeRight: () => void;
}

export function useLeftEdgeSwipe({
  enabled = true,
  edgeSize = 28,
  threshold = 60,
  onSwipeRight,
}: EdgeSwipeOptions) {
  useEffect(() => {
    if (!enabled) return;

    let startX = 0;
    let startY = 0;
    let tracking = false;
    let fired = false;

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        tracking = false;
        return;
      }
      const t = e.touches[0];
      if (t.clientX <= edgeSize) {
        startX = t.clientX;
        startY = t.clientY;
        tracking = true;
        fired = false;
      } else {
        tracking = false;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!tracking || fired) return;
      const t = e.touches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (dx >= threshold && Math.abs(dx) > Math.abs(dy) * 1.2) {
        fired = true;
        tracking = false;
        onSwipeRight();
      } else if (Math.abs(dy) > Math.abs(dx) * 1.5) {
        tracking = false;
      }
    };

    const onTouchEnd = () => {
      tracking = false;
      fired = false;
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    document.addEventListener("touchcancel", onTouchEnd, { passive: true });

    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [enabled, edgeSize, threshold, onSwipeRight]);
}
