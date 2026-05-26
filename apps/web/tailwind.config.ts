import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "#f7f7f4",
        foreground: "#1f2933",
        panel: "#ffffff",
        border: "#d8ddd5",
        accent: "#0f766e",
        danger: "#b42318"
      }
    }
  },
  plugins: []
} satisfies Config;
