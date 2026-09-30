// Memories are stored in plain text and sent to the model on every task, so credentials never go in:
// signing in is left to the browser's own saved-password autofill.
const SECRET_WORDS =
  /pass(word|wd|code|phrase)|\bpwd\b|\bcvv\b|\bcvc\b|\botp\b|api[-_ ]?key|(access|auth|api|bearer|refresh)[-_ ]token|密码|密碼|口令|验证码|驗證碼/i;
const KEY_SHAPES = [
  /\b(sk|pk|rk|ghp|gho|ghs|glpat|xox[abps])[-_][A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
];
const LONG_RANDOM = /[A-Za-z0-9+/_-]{32,}/g;
const DIGIT_RUN = /\d(?:[ -]?\d){12,18}/g;

function passesLuhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** True when the text names or contains a password, key, token or card number */
export function looksSecret(text: string): boolean {
  if (SECRET_WORDS.test(text)) return true;
  if (KEY_SHAPES.some(shape => shape.test(text))) return true;
  if ((text.match(LONG_RANDOM) ?? []).some(run => /\d/.test(run) && /[A-Za-z]/.test(run))) return true;
  return (text.match(DIGIT_RUN) ?? []).some(run => passesLuhn(run.replace(/\D/g, '')));
}
