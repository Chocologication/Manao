export type LoginRequest = { username: string; password: string };
export type AuthUser = {
  id: string;
  username: string;
  /** Display-only fields; legacy accounts may have a null email. */
  email?: string | null;
  emailVerified?: boolean;
};
export type LoginResponse = {
  accessToken: string;
  expiresAt: string;
  user: AuthUser;
};

/** Design section 9: GET /api/v1/auth/options */
export type AuthOptionsResponse = {
  registrationEnabled: boolean;
  emailAvailable: boolean;
};

/** Design section 9: GET /api/v1/auth/captcha. Never carries the answer. */
export type CaptchaResponse = {
  challengeId: string;
  imageBase64: string;
  expiresAt: string;
};

export type EmailCodePurpose = 'REGISTER_EMAIL' | 'RESET_PASSWORD';

export type EmailCodeRequest = {
  purpose: EmailCodePurpose;
  email: string;
  captchaId: string;
  captchaAnswer: string;
};

export type EmailCodeResponse = {
  challengeId: string;
  expiresAt: string;
  retryAfterSeconds: number;
};

export type RegisterRequest = {
  username: string;
  password: string;
  email: string;
  emailChallengeId: string;
  emailCode: string;
};

export type RegisterResponse = {
  user: { id: string; username: string };
};

export type PasswordResetRequest = {
  email: string;
  emailChallengeId: string;
  emailCode: string;
  newPassword: string;
};

export type PasswordChangeRequest = {
  currentPassword: string;
  newPassword: string;
};

/** Design section 9: GET /api/v1/auth/me */
export type MeResponse = {
  id: string;
  username: string;
  email: string | null;
  emailVerified: boolean;
};

/** Fixed account-lifecycle error codes from design section 9. */
export type AuthErrorCode =
  | 'VALIDATION_ERROR'
  | 'CAPTCHA_INVALID'
  | 'EMAIL_CODE_INVALID'
  | 'AUTH_RATE_LIMITED'
  | 'USERNAME_TAKEN'
  | 'EMAIL_TAKEN'
  | 'REGISTRATION_CLOSED'
  | 'MAIL_NOT_CONFIGURED'
  | 'MAIL_SEND_FAILED'
  | 'CURRENT_PASSWORD_INVALID';
