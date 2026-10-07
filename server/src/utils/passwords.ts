/**
 * The passwords that must never be accepted, no matter the length rule.
 *
 * Length alone approves "password123" (11 characters, cracked instantly), so
 * signup, password change and reset-confirm all check this list too. Exact
 * lowercase match only: substring rules ("no password containing 'dragon'")
 * reject legitimate passphrases and teach users to game the check.
 */
const COMMON_PASSWORDS = new Set([
  "password",
  "password1",
  "password12",
  "password123",
  "password2024",
  "password2025",
  "password2026",
  "qwerty",
  "qwerty123",
  "qwertyuiop",
  "12345678",
  "123456789",
  "1234567890",
  "00000000",
  "11111111",
  "abc12345",
  "abcd1234",
  "letmein",
  "letmein123",
  "welcome",
  "welcome1",
  "welcome123",
  "monkey",
  "dragon",
  "football",
  "baseball",
  "superman",
  "trustno1",
  "iloveyou",
  "princess",
  "sunshine",
  "master",
  "hunter2",
  "changeme",
  "changeme123",
  "admin123",
  "shipit123",
  "opencode",
  "opencode123",
]);

export function isCommonPassword(password: string): boolean {
  return COMMON_PASSWORDS.has(password.trim().toLowerCase());
}
