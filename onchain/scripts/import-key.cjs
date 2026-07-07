/* Convert a wallet secret into a Solana CLI keypair file, locally.
 *
 * Reads onchain/deployer.secret (either a base58 string exported from Phantom/Solflare,
 * OR a JSON byte-array like ~/.config/solana/id.json) and writes onchain/deployer.json
 * in the CLI keypair format. Verifies the derived address matches the expected wallet,
 * so a wrong/typo'd key is caught before any deploy.
 *
 * The secret never leaves this machine: it's read from a gitignored file.
 */
const fs = require('node:fs')
const { Keypair } = require('@solana/web3.js')
const _bs58 = require('bs58')
const bs58 = _bs58.default || _bs58

const EXPECTED = process.env.EXPECTED_WALLET || '4mHMCwEVxX2Sjp1NKsM89zcSzeZhUNvhedUohXztL78w'
const SRC = '/work/deployer.secret'
const OUT = '/work/deployer.json'

if (!fs.existsSync(SRC)) {
  console.error(`missing ${SRC} - put your wallet secret there first`)
  process.exit(2)
}
const raw = fs.readFileSync(SRC, 'utf8').trim()

let secret
if (raw.startsWith('[')) {
  secret = Uint8Array.from(JSON.parse(raw))
} else {
  const decoded = bs58.decode(raw)
  if (decoded.length === 64) secret = Uint8Array.from(decoded)
  else if (decoded.length === 32) secret = Keypair.fromSeed(Uint8Array.from(decoded)).secretKey
  else { console.error(`unrecognized key length ${decoded.length} (expected 64 or 32 bytes)`); process.exit(2) }
}

const kp = Keypair.fromSecretKey(secret)
const got = kp.publicKey.toBase58()
if (got !== EXPECTED) {
  console.error(`MISMATCH: this key is for ${got}, but expected ${EXPECTED}.`)
  console.error('Did you paste the secret for the right wallet?')
  process.exit(1)
}
fs.writeFileSync(OUT, JSON.stringify(Array.from(secret)))
console.log(`OK - deployer.json written for ${got}`)
