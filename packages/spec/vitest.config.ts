/** Vitest configuration for the spec package. See docs/testing.md. */
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["scripts/**/*.test.ts"],
    },
});
