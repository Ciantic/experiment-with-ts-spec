import type { Brand } from "../../primitives/Brand.ts";

/**
 * The signed one-time token a verification link carries; the server's secret validates it without a stored row.
 *
 * @primitive
 * @pgType text
 * @zod z.string().regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/).brand<"EmailVerificationToken">()
 */
export type EmailVerificationToken = string & Brand<"EmailVerificationToken">;
