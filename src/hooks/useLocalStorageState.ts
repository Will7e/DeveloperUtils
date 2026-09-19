import { useState, useEffect } from "react";

/**
 * Hook for persisting state in localStorage with JSON serialization.
 */
export function useLocalStorageState<T>(
  key: string,
  defaultValue: T
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const item =
        window.localStorage.getItem(key) ??
        (key.startsWith("intab_")
          ? window.localStorage.getItem(key.replace("intab_", "devutils_"))
          : null);
      return item ? JSON.parse(item) : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Ignore localStorage write errors
    }
  }, [key, value]);

  return [value, setValue];
}
