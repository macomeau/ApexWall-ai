/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Locode Warm Desert Sand / Terracotta Gold palette (backported from upstream 14b0073)
        blue: {
          50: "#FAF7F2",
          100: "#F5EFE6",
          200: "#EADECF",
          300: "#DFCCB4",
          400: "#E2B88E",
          500: "#D4A373",
          600: "#C4925F",
          700: "#A67645",
          800: "#7E552C",
          900: "#543619",
          950: "#2C1A0B",
        },
        gold: {
          DEFAULT: "#D4A373",
          hover: "#E2B88E",
          subtle: "rgba(212, 163, 115, 0.14)",
          border: "rgba(212, 163, 115, 0.35)",
          text: "#E5B98F",
          light: "#EADECF",
        },
        copper: {
          DEFAULT: "#D4A373",
          hover: "#E2B88E",
          subtle: "rgba(212, 163, 115, 0.14)",
          border: "rgba(212, 163, 115, 0.35)",
          text: "#E5B98F",
          light: "#EADECF",
        },
        telemetry: {
          cyan: "#38bdf8",
          red: "#f43f5e",
          orange: "#fb923c",
          green: "#34d399",
          amber: "#fbbf24",
        },
      },
      fontFamily: {
        display: ["Rajdhani", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
        body: ["Inter", "sans-serif"],
      },
    },
  },
  plugins: [],
};
