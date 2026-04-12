import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // LocalNet/KMD-backed MCP E2E suites share mutable chain state and the same
    // default deployer account, so file-level parallelism makes them race.
    fileParallelism: false,
  },
});
