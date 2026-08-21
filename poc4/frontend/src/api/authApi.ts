import type { LoginRequest, LoginResponse } from '../contracts/auth';
import { getHttpClient } from './httpClient';

export function login(request: LoginRequest): Promise<LoginResponse> {
  return getHttpClient().request<LoginResponse>('/api/v1/auth/login', {
    method: 'POST',
    body: request,
    auth: false,
  });
}
