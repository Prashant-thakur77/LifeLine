"use client";

import { useEffect } from "react";

/**
 * Smooth scrolling for the landing page only: a soft, weighted glide on mouse and
 * trackpad. Touch keeps the device's own scrolling, and reduced motion keeps native
 * scrolling everywhere. The tool pages never load it.
 */
export function SmoothScroll() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (!window.matchMedia("(pointer: fine)").matches) return;
    let destroy = () => {};
    let cancelled = false;
    void import("lenis").then(({ default: Lenis }) => {
      if (cancelled) return;
      const lenis = new Lenis({ autoRaf: true, lerp: 0.11, wheelMultiplier: 0.9 });
      destroy = () => lenis.destroy();
    });
    return () => {
      cancelled = true;
      destroy();
    };
  }, []);
  return null;
}
