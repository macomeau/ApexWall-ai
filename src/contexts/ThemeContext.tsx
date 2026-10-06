"use client";

import React, { createContext, useContext, useEffect, useState } from "react";

export type DisplayTheme = "slate" | "light" | "amoled";

interface ThemeContextType {
  theme: DisplayTheme;
  isAmoled: boolean;
  isLight: boolean;
  toggleTheme: () => void;
  setTheme: (theme: DisplayTheme) => void;
  themeLabel: string;
}

const ThemeContext = createContext<ThemeContextType>({
  theme: "slate",
  isAmoled: false,
  isLight: false,
  toggleTheme: () => {},
  setTheme: () => {},
  themeLabel: "Slate",
});

const THEME_ORDER: DisplayTheme[] = ["slate", "light", "amoled"];
const THEME_LABELS: Record<DisplayTheme, string> = {
  slate: "Slate",
  light: "Light",
  amoled: "AMOLED",
};

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setThemeState] = useState<DisplayTheme>("slate");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const saved = localStorage.getItem("apexwall_display_theme") as DisplayTheme | null;
    if (saved === "amoled" || saved === "slate" || saved === "light") {
      setThemeState(saved);
      applyThemeToDom(saved);
    } else {
      // Default to soft Obsidian Slate for smooth, glare-free executive eye appeal
      setThemeState("slate");
      applyThemeToDom("slate");
    }
  }, []);

  const applyThemeToDom = (newTheme: DisplayTheme) => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const body = document.body;

    root.classList.remove("amoled", "light");
    body.classList.remove("amoled", "light");
    if (newTheme === "amoled") {
      root.classList.add("amoled");
      body.classList.add("amoled");
    } else if (newTheme === "light") {
      root.classList.add("light");
      body.classList.add("light");
    }
    root.setAttribute("data-theme", newTheme);
  };

  const setTheme = (newTheme: DisplayTheme) => {
    setThemeState(newTheme);
    localStorage.setItem("apexwall_display_theme", newTheme);
    applyThemeToDom(newTheme);
  };

  const toggleTheme = () => {
    const idx = THEME_ORDER.indexOf(theme);
    const next = THEME_ORDER[(idx + 1) % THEME_ORDER.length];
    setTheme(next);
  };

  return (
    <ThemeContext.Provider
      value={{
        theme,
        isAmoled: theme === "amoled",
        isLight: theme === "light",
        toggleTheme,
        setTheme,
        themeLabel: THEME_LABELS[theme],
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => useContext(ThemeContext);
