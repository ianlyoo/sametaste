import { defineConfig } from "vitest/config";

// Resolve the "@/..." paths from tsconfig, as Next does.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: { exclude: ["**/node_modules/**", "**/.next/**", ".scratch/**", "drafts/**"] },
});
