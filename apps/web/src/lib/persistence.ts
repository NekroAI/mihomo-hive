import React from "react";

export function useLocalStorageState<T>(key: string, initialValue: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = React.useState<T>(() => {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return initialValue;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      return initialValue;
    }
  });

  React.useEffect(() => {
    window.localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue];
}
