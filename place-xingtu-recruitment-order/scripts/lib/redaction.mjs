const secretKeyPattern = /(?:password|passcode|otp|verification.?code|cookie|session|authorization|access.?token|refresh.?token|secret|private.?message|contact|local.?storage|session.?storage)/iu;
const secretValuePatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu,
  /\b(?:cookie|password|passcode|otp|token|authorization)\s*[:=]\s*[^\s,;]+/giu,
  /https?:\/\/[^\s?]+\?[^\s]*(?:token|code|ticket|auth)=[^\s&]+/giu,
];

export function containsForbiddenPrivateValue(value) {
  if (typeof value !== "string") return false;
  return secretValuePatterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

function redactString(value) {
  let redacted = value;
  for (const pattern of secretValuePatterns) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}

export function redact(value, seen = new WeakSet()) {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[REDACTED:CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value.map((item) => redact(item, seen));
    seen.delete(value);
    return result;
  }

  const result = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = secretKeyPattern.test(key) ? "[REDACTED]" : redact(child, seen);
  }
  seen.delete(value);
  return result;
}
