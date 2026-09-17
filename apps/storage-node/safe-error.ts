/** Redact sensitive values while retaining bounded operational context. */
export function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/https?:\/\/[^\s]+/gi, "[endpoint]")
    .replace(/(password|token|secret|private key|recovery phrase|seed|dek)(?:\s*[:=]\s*)?[^\s:;,)]*/gi, "$1 [redacted]")
    .slice(0, 300);
}
