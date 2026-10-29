/** Vitest configuration for the root generators and their models. See docs/testing.md. */
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["scripts/{spec,infra,backend,sdk,oxlint}/**/*.test.ts"],
    },
});
