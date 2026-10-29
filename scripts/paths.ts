/** Workspace paths anchored to this file, so no script depends on the current working directory. */
import { dirname, join } from "node:path";

/** The repository root: the parent of `scripts/`. */
export const REPO_ROOT = dirname(import.meta.dirname);

/** The `spec` package root. */
export const SPEC_PACKAGE_ROOT = join(REPO_ROOT, "packages/spec");

/** The `backend` package root. */
export const BACKEND_PACKAGE_ROOT = join(REPO_ROOT, "packages/backend");

/** The `infra` package root. */
export const INFRA_PACKAGE_ROOT = join(REPO_ROOT, "packages/infra");

/** The `sdk` package root. */
export const SDK_PACKAGE_ROOT = join(REPO_ROOT, "packages/sdk");
