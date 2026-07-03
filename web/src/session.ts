/* Tiny client session: the developer API key and provider token live in
   localStorage. No wallet signature is required by the gateway today - the
   API key IS the credential - so "Connect Wallet" just labels the account. */

const K = {
  apiKey: 'ggrid_api_key',
  userId: 'ggrid_user_id',
  wallet: 'ggrid_wallet',
  provToken: 'ggrid_provider_token',
  provId: 'ggrid_provider_id',
}

const get = (k: string) => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const set = (k: string, v: string | null) => {
  try {
    if (v == null) localStorage.removeItem(k)
    else localStorage.setItem(k, v)
  } catch {
    /* private mode */
  }
}

export const session = {
  // developer
  apiKey: () => get(K.apiKey),
  userId: () => get(K.userId),
  wallet: () => get(K.wallet),
  setWallet: (w: string) => set(K.wallet, w),
  clearWallet: () => set(K.wallet, null),
  signIn(apiKey: string, userId?: string, wallet?: string) {
    set(K.apiKey, apiKey)
    if (userId) set(K.userId, userId)
    if (wallet) set(K.wallet, wallet)
  },
  signOut() {
    set(K.apiKey, null)
    set(K.userId, null)
    set(K.wallet, null)
  },
  // provider
  providerToken: () => get(K.provToken),
  providerId: () => get(K.provId),
  setProvider(token: string, id?: string) {
    set(K.provToken, token)
    if (id) set(K.provId, id)
  },
  clearProvider() {
    set(K.provToken, null)
    set(K.provId, null)
  },
}
