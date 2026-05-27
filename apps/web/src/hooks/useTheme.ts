import React from "react";

export type Theme = "auto" | "light" | "dark";
const STORAGE_KEY = "mihomo-hive.theme";

/**
 * 主题选择：auto / light / dark。
 *
 *   auto  → 不设 data-theme，让 @media (prefers-color-scheme: dark) 接管
 *   light → data-theme="light" 强制浅色
 *   dark  → data-theme="dark" 强制深色
 *
 * 持久化到 localStorage；首次访问默认 auto。
 */
export function useTheme(): { theme: Theme; setTheme: (next: Theme) => void } {
  const [theme, setThemeState] = React.useState<Theme>(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === "light" || stored === "dark" || stored === "auto") return stored;
    } catch {
      // ignore
    }
    return "auto";
  });

  React.useEffect(() => {
    const root = document.documentElement;
    if (theme === "auto") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", theme);
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // ignore
    }
  }, [theme]);

  return { theme, setTheme: setThemeState };
}
