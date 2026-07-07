import { PrivyProvider } from '@privy-io/react-auth'
import Dashboard from './Dashboard'

// The console is the only place that needs Privy, so we wrap it here (this file is
// lazy-loaded) - the landing page never pays for the Privy SDK.
// App ID is public; overridable at build time via VITE_PRIVY_APP_ID.
const PRIVY_APP_ID =
  ((import.meta as any).env?.VITE_PRIVY_APP_ID as string | undefined) ?? 'cmraq7xzq00i60cjv2vahcpsm'

export default function ConsoleRoot({ tab }: { tab: 'app' | 'providers' }) {
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        appearance: {
          theme: 'dark',
          accentColor: '#5fd4e2',
          logo: '/logo.png',
          walletChainType: 'solana-only',
        },
        loginMethods: ['email', 'wallet', 'google'],
        embeddedWallets: { solana: { createOnLogin: 'users-without-wallets' } },
      }}
    >
      <Dashboard tab={tab} />
    </PrivyProvider>
  )
}
