export const UNCALIBRATED_RECRUITMENT_STATUS = "UNCONFIRMED";
export const MAX_RECRUITMENT_STATUS_CODE_POINTS = 64;
export const MAX_RECRUITMENT_STATUS_UTF8_BYTES = 128;

const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/u;
const formatCharacters = /\p{Cf}/u;
const edgeWhitespace = /^(?:\p{White_Space})|(?:\p{White_Space})$/u;

export function validateRecruitmentCompletionStatus(value) {
  if (typeof value !== "string") {
    throw new Error("recruitment completion status must be a primitive string");
  }
  const codePointLength = [...value].length;
  if (
    codePointLength === 0 ||
    codePointLength > MAX_RECRUITMENT_STATUS_CODE_POINTS ||
    Buffer.byteLength(value, "utf8") > MAX_RECRUITMENT_STATUS_UTF8_BYTES
  ) throw new Error("recruitment completion status exceeds its strict finite bounds");
  if (value.normalize("NFC") !== value) {
    throw new Error("recruitment completion status must be NFC-normalized");
  }
  if (controlCharacters.test(value) || formatCharacters.test(value)) {
    throw new Error("recruitment completion status contains a forbidden control or format character");
  }
  if (edgeWhitespace.test(value)) {
    throw new Error("recruitment completion status cannot have leading or trailing whitespace");
  }
  return value;
}

export function classifyRecruitmentCompletionStatus(value) {
  const status = validateRecruitmentCompletionStatus(value);
  return Object.freeze({
    kind: status === UNCALIBRATED_RECRUITMENT_STATUS ? "UNCALIBRATED" : "CALIBRATED",
    value: status,
  });
}
