/** Vitest configuration for the backend package. See docs/testing.md. */
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["scripts/**/*.test.ts", "postgres/**/*.test.ts"],
    },
});
