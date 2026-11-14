/** A user-facing message for an unknown thrown value. */
export function errorMessage(cause: unknown, fallback?: string): string {
  if (typeof cause === "string") return cause;
  if (cause instanceof Error) return cause.message;
  if (cause && typeof cause === "object" && "message" in cause) {
    return String((cause as { message: unknown }).message);
  }
  return fallback ?? String(cause);
}
