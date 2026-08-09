import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    coverage: { reporter: ["text", "html"] },
    environment: "node",
    restoreMocks: true,
  },
});
