export interface TokenSet {
  accessToken: string;
  tokenType: string;
  // Absent for grants that don't issue refresh tokens (e.g. client_credentials,
  // where re-authentication is just another machine-to-machine POST).
  refreshToken?: string;
  scope?: string;
  expiresAt?: number;
}
