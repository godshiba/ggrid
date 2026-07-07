import { config } from './config'

// Verifies Privy access tokens against Privy's public JWKS (needs only the App ID,
// which is public). `jose` is imported lazily so the gateway boots and tests run
// without it, and so obviously-non-Privy tokens (API keys) never touch the network.

// A Privy access token is a standard JWT: header.payload.signature (base64url).
export function looksLikeJwt(token: string): boolean {
  return /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)
}

let jwksCache: any = null

export interface PrivyClaims {
  privyId: string // the Privy DID, e.g. did:privy:xxxx...
}

export async function verifyPrivyToken(token: string): Promise<PrivyClaims | null> {
  if (!looksLikeJwt(token)) return null
  try {
    const { createRemoteJWKSet, jwtVerify } = await import('jose')
    if (!jwksCache) {
      jwksCache = createRemoteJWKSet(
        new URL(`https://auth.privy.io/api/v1/apps/${config.privyAppId}/jwks.json`),
      )
    }
    const { payload } = await jwtVerify(token, jwksCache, {
      issuer: 'privy.io',
      audience: config.privyAppId,
    })
    if (!payload.sub) return null
    return { privyId: payload.sub }
  } catch {
    return null // invalid / expired / wrong-app token
  }
}
