/** Vitest configuration for the backend-effect package. See docs/testing.md. */
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["scripts/**/*.test.ts", "src/**/*.test.ts"],
    },
});
