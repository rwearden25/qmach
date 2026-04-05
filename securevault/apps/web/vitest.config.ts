import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },

  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["./src/__tests__/setup.ts"],
    globals: true,
    testTimeout: 10_000,
    css: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      exclude: ["node_modules/", "src/__tests__/", "**/*.d.ts"],
    },
  },
});
