import { defineConfig } from "vitest/config";

// Vitest configuration for Node-based unit tests.
export default defineConfig({
  test: {
    environment: "node"
  }
});
