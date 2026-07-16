import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f5f7fa",
          600: "#0f172a",
          700: "#0b1220",
        },
        accent: { 500: "#f59e0b" },
      },
    },
  },
  plugins: [],
} satisfies Config;
