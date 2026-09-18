/** Deployment constants for the LotIQ staging environment the bridge talks to. */
export const CONFIG = {
  /** lotiq-staging-api (HTTP API). */
  apiBaseUrl: 'https://etafooe4n9.execute-api.us-east-1.amazonaws.com',
  /** Cognito staging user pool app client (USER_PASSWORD_AUTH enabled). */
  cognitoRegion: 'us-east-1',
  cognitoClientId: '11m77d67lbodp679tal0kjbg4e',
  /** Stamped into the provision job's audit trail (provisioning.appVersion). */
  appVersion: '0.1.0-expo',
} as const;

/** `reolink#<model>#<firmware>` — the camera-profile id the backend renders golden config from. */
export function profileIdFor(model?: string, firmware?: string): string | undefined {
  if (!model || !firmware) return undefined;
  return `reolink#${model}#${firmware}`;
}
