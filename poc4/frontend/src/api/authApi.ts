import type {
  AuthOptionsResponse,
  CaptchaResponse,
  EmailCodeRequest,
  EmailCodeResponse,
  LoginRequest,
  LoginResponse,
  MeResponse,
  PasswordChangeRequest,
  PasswordResetRequest,
  RegisterRequest,
  RegisterResponse,
} from '../contracts/auth';
import { ApiRequestError } from './ApiRequestError';
import { getHttpClient } from './httpClient';

export function login(request: LoginRequest): Promise<LoginResponse> {
  return getHttpClient().request<LoginResponse>('/api/v1/auth/login', {
    method: 'POST',
    body: request,
    auth: false,
  });
}

export function getAuthOptions(): Promise<AuthOptionsResponse> {
  return getHttpClient().request<AuthOptionsResponse>('/api/v1/auth/options', {
    auth: false,
  });
}

export function getCaptcha(): Promise<CaptchaResponse> {
  return getHttpClient().request<CaptchaResponse>('/api/v1/auth/captcha', {
    auth: false,
  });
}

export function requestEmailCode(request: EmailCodeRequest): Promise<EmailCodeResponse> {
  return getHttpClient().request<EmailCodeResponse>('/api/v1/auth/email-codes', {
    method: 'POST',
    body: request,
    auth: false,
  });
}

export function register(request: RegisterRequest): Promise<RegisterResponse> {
  return getHttpClient().request<RegisterResponse>('/api/v1/auth/register', {
    method: 'POST',
    body: request,
    auth: false,
  });
}

export function resetPassword(request: PasswordResetRequest): Promise<void> {
  return getHttpClient().request<void>('/api/v1/auth/password-reset', {
    method: 'POST',
    body: request,
    auth: false,
  });
}

export function changePassword(request: PasswordChangeRequest): Promise<void> {
  return getHttpClient().request<void>('/api/v1/auth/password-change', {
    method: 'POST',
    body: request,
  });
}

export function getMe(): Promise<MeResponse> {
  return getHttpClient().request<MeResponse>('/api/v1/auth/me');
}

/**
 * Fixed account-lifecycle error codes are business answers, not session expiry:
 * only a current-token 401 triggers the unified anonymous cleanup.
 */
export function authErrorCode(error: unknown): string | null {
  return error instanceof ApiRequestError ? error.body?.code ?? `HTTP_${error.status}` : null;
}

export function isNetworkError(error: unknown): boolean {
  return error instanceof Error && /network request failed/i.test(error.message);
}
