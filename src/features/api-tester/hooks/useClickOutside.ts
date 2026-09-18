import { useEffect, useRef, type RefObject } from "react";

/**
 * Hook that fires a callback when a click happens outside of the referenced element.
 * Replaces 4+ identical click-outside implementations across the API tester dropdowns.
 */
export function useClickOutside<T extends HTMLElement>(
  callback: () => void,
  active = true
): RefObject<T | null> {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    if (!active) return;

    function handleClickOutside(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        callback();
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [callback, active]);

  return ref;
}
