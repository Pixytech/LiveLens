interface GsiTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  error?: string;
  error_description?: string;
}

interface GsiTokenClient {
  requestAccessToken(config?: { prompt?: string }): void;
}

interface GoogleOAuth2 {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    callback: (response: GsiTokenResponse) => void;
    error_callback?: (err: { type: string }) => void;
  }): GsiTokenClient;
  revoke(token: string, done?: () => void): void;
}

declare const google: {
  accounts: {
    oauth2: GoogleOAuth2;
  };
};
