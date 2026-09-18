/**
 * Cognito sign-in for the installer, over the Cognito Identity Provider REST API — plain `fetch`, no
 * SDK, so it runs unchanged in Expo Go. USER_PASSWORD_AUTH must be enabled on the app client (it is
 * on the staging client). Returns the IdToken the API's `requireAuth` verifies.
 */
import { CONFIG } from './config.ts';

const ENDPOINT = `https://cognito-idp.${CONFIG.cognitoRegion}.amazonaws.com/`;

export interface LoginResult {
  idToken: string;
  accessToken: string;
  expiresAt: number; // epoch ms
}

export async function cognitoLogin(username: string, password: string): Promise<LoginResult> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': 'AWSCognitoIdentityProviderService.InitiateAuth',
    },
    body: JSON.stringify({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: CONFIG.cognitoClientId,
      AuthParameters: { USERNAME: username.trim(), PASSWORD: password },
    }),
  });
  const json = await res.json().catch(() => ({}) as Record<string, unknown>);
  if (!res.ok) {
    // Cognito returns { __type, message }. Map the common ones to something an operator understands.
    const type = String((json as Record<string, unknown>).__type ?? '');
    const msg = String((json as Record<string, unknown>).message ?? 'Sign-in failed');
    if (type.includes('NotAuthorized')) throw new Error('Wrong email or password.');
    if (type.includes('UserNotFound')) throw new Error('No account for that email.');
    if (type.includes('UserNotConfirmed')) throw new Error('Account not confirmed yet.');
    throw new Error(msg);
  }
  const challenge = (json as Record<string, unknown>).ChallengeName;
  if (challenge) {
    throw new Error(`Account needs attention in the console (${String(challenge)}).`);
  }
  const auth = (json as Record<string, unknown>).AuthenticationResult as
    | { IdToken?: string; AccessToken?: string; ExpiresIn?: number }
    | undefined;
  if (!auth?.IdToken) throw new Error('Sign-in returned no token.');
  return {
    idToken: auth.IdToken,
    accessToken: auth.AccessToken ?? '',
    expiresAt: Date.now() + (auth.ExpiresIn ?? 3600) * 1000,
  };
}
