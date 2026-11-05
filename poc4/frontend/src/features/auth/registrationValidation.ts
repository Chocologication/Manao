export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 64;
const PASSWORD_MAX_UTF8_BYTES = 72;

export function validateNewPassword(password: string): string | null {
  const length = Array.from(password).length;
  if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) {
    return '密码需为 8–64 个字符。';
  }
  if (new TextEncoder().encode(password).length > PASSWORD_MAX_UTF8_BYTES) {
    return '密码过长，请缩短后重试。';
  }
  return null;
}
