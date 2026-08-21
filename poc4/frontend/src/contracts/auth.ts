export type LoginRequest = { username: string; password: string };
export type AuthUser = { id: string; username: string };
export type LoginResponse = {
  accessToken: string;
  expiresAt: string;
  user: AuthUser;
};
