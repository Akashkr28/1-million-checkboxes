import { decodeJwtPayload, pkceChallenge, randomToken } from '../utils/oauth.js';

let oidcMetadata = null;

export async function initOIDC() {
  const issuerUrl = process.env.OIDC_ISSUER;
  if (!issuerUrl) {
    console.warn('[Auth] OIDC_ISSUER not set - demo login enabled');
    return;
  }
  try {
    const base = issuerUrl.replace(/\/$/, '');
    const response = await fetch(`${base}/.well-known/openid-configuration`);
    if (!response.ok) throw new Error(`Discovery failed with HTTP ${response.status}`);
    oidcMetadata = await response.json();
    console.log(`[Auth] OIDC client ready (issuer: ${issuerUrl})`);
  } catch (err) {
    console.error('[Auth] Failed to discover OIDC issuer:', err.message);
  }
}

export function getAuthorizationUrl(session) {
  if (!oidcMetadata) throw new Error('OIDC not configured');
  const codeVerifier = randomToken(48);
  const nonce = randomToken(24);
  const state = randomToken(24);
  session.oidcState = { codeVerifier, nonce, state };

  const url = new URL(oidcMetadata.authorization_endpoint);
  url.searchParams.set('client_id', process.env.OIDC_CLIENT_ID);
  url.searchParams.set('redirect_uri', process.env.OIDC_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', process.env.OIDC_SCOPE || 'openid email profile');
  url.searchParams.set('code_challenge', pkceChallenge(codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('state', state);
  return url.toString();
}

export async function handleCallback(req) {
  if (!oidcMetadata) throw new Error('OIDC not configured');
  const { codeVerifier, state } = req.session.oidcState || {};
  if (!codeVerifier) throw new Error('Missing OIDC state — possible CSRF');
  if (req.query.state !== state) throw new Error('Invalid OIDC state');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: req.query.code,
    redirect_uri: process.env.OIDC_REDIRECT_URI,
    client_id: process.env.OIDC_CLIENT_ID,
    code_verifier: codeVerifier,
  });
  if (process.env.OIDC_CLIENT_SECRET) {
    body.set('client_secret', process.env.OIDC_CLIENT_SECRET);
  }

  const tokenResponse = await fetch(oidcMetadata.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!tokenResponse.ok) throw new Error(`Token exchange failed with HTTP ${tokenResponse.status}`);

  const tokenSet = await tokenResponse.json();
  let claims = decodeJwtPayload(tokenSet.id_token);
  if (oidcMetadata.userinfo_endpoint && tokenSet.access_token) {
    const userInfoResponse = await fetch(oidcMetadata.userinfo_endpoint, {
      headers: { authorization: `Bearer ${tokenSet.access_token}` },
    });
    if (userInfoResponse.ok) {
      claims = { ...claims, ...(await userInfoResponse.json()) };
    }
  }

  return {
    userId:      claims.sub,
    email:       claims.email || '',
    name:        claims.name || claims.preferred_username || claims.email || 'User',
    accessToken: tokenSet.access_token || '',
  };
}

export function sessionAuth(req, _res, next) {
  req.user = req.session && req.session.userId
    ? { userId: req.session.userId, email: req.session.userEmail, name: req.session.userName }
    : null;
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized', loginUrl: '/auth/login' });
  }
  next();
}

export function isOIDCEnabled() {
  return !!oidcMetadata;
}
