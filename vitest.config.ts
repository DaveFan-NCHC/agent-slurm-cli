import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "html", "lcov", "json-summary", "cobertura"],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
        "src/policy/**": {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
        "src/session/**": {
          statements: 80,
          branches: 65,
          functions: 65,
          lines: 80,
        },
        "src/slurm/**": {
          statements: 80,
          branches: 75,
          functions: 90,
          lines: 85,
        },
        "src/transport/**": {
          statements: 65,
          branches: 55,
          functions: 60,
          lines: 70,
        },
      },
    },
  },
});
