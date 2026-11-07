import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // Clears AC_HOME / AC_APPDATA / AC_CONFIG_HOME so a developer's own
    // settings cannot override the temporary HOME a test builds.
    setupFiles: ["test/setup-env.ts"],
    testTimeout: 20000,
  },
});
