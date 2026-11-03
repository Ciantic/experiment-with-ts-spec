/** Vitest configuration for the operations package. See docs/testing.md. */
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["src/**/*.test.ts"],
    },
});
