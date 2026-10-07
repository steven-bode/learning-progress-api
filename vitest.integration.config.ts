import { defineConfig } from "vitest/config";
import { TEST_ENDPOINT, TEST_REGION, TEST_TABLE } from "./tests/constants.js";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts", "tests/functional/**/*.test.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    env: {
      TABLE_NAME: TEST_TABLE,
      AWS_REGION: TEST_REGION,
      DYNAMODB_ENDPOINT: TEST_ENDPOINT,
      AUTH_MODE: "local",
      AWS_ACCESS_KEY_ID: "localkey",
      AWS_SECRET_ACCESS_KEY: "localkey",
    },
  },
});
