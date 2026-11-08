"use client";

import { useEffect, useState } from "react";

/** True when the viewport is at least `px` wide. False until known, so the first paint is the phone layout. */
export function useMinWidth(px: number): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(`(min-width: ${px}px)`);
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [px]);
  return wide;
}
