/**
 * The Stellar layer: reading the network, diffing the manifest against what an
 * account already holds, building transactions, and talking to wallets. Nothing
 * here touches the DOM or the page's state — every function takes what it
 * needs, so it can be read (and checked) on its own.
 *
 * Reads and submits over Soroban RPC. Horizon is deprecated, and RPC can serve
 * both jobs here: the manifest names every asset up front, so the trustline
 * ledger keys can be built directly rather than enumerated.
 */

const RPC_URL = 'https://mainnet.sorobanrpc.com'
const NETWORK_PASSPHRASE = StellarSdk.Networks.PUBLIC

/** Reserve locked per subentry, in XLM. A trustline is one subentry. */
const BASE_RESERVE = 0.5

/** Protocol cap on operations in a single transaction. */
const MAX_OPS_PER_TX = 100

/** Per-operation fee bid, in stroops. Well above base to survive surge. */
const FEE_PER_OP = '10000'

const STROOPS_PER_XLM = 10_000_000

/** `AUTHORIZED_FLAG` on `TrustLineEntry.flags`. */
const TRUSTLINE_AUTHORIZED = 1

const { xdr, Asset, Account, Keypair, StrKey, TransactionBuilder, Operation } =
  StellarSdk

// ---------------------------------------------------------------- RPC

async function rpc(method, params) {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!response.ok) throw new Error(`RPC ${method}: HTTP ${response.status}`)
  const body = await response.json()
  if (body.error) throw new Error(`RPC ${method}: ${body.error.message}`)
  return body.result
}

const accountLedgerKey = (address) =>
  xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({
      accountId: Keypair.fromPublicKey(address).xdrAccountId(),
    })
  ).toXDR('base64')

const trustlineLedgerKey = (address, code, issuer) =>
  xdr.LedgerKey.trustline(
    new xdr.LedgerKeyTrustLine({
      accountId: Keypair.fromPublicKey(address).xdrAccountId(),
      asset: new Asset(code, issuer).toTrustLineXDRObject(),
    })
  ).toXDR('base64')

const isValidAddress = (address) => StrKey.isValidEd25519PublicKey(address)

/**
 * Reads ledger entries in chunks, keyed by the request key. The RPC omits keys
 * that do not resolve and does not guarantee ordering, so absence is meaningful
 * and every lookup goes through the key.
 */
async function readLedgerEntries(keys) {
  const found = new Map()
  for (let i = 0; i < keys.length; i += MAX_OPS_PER_TX) {
    const result = await rpc('getLedgerEntries', {
      keys: keys.slice(i, i + MAX_OPS_PER_TX),
    })
    for (const entry of result.entries ?? []) {
      found.set(entry.key, xdr.LedgerEntryData.fromXDR(entry.xdr, 'base64'))
    }
  }
  return found
}

/**
 * Pulls the sponsorship counts and selling liabilities off the `AccountEntry`
 * extension chain. Both feed the reserve calculation: sponsored subentries are
 * paid for by someone else, and liabilities are already spoken for.
 */
function readAccountExtensions(account) {
  const extensions = { numSponsoring: 0, numSponsored: 0, sellingLiabilities: 0 }
  const ext = account.ext()
  if (ext.switch() !== 1) return extensions

  const v1 = ext.v1()
  extensions.sellingLiabilities = Number(v1.liabilities().selling().toString())

  const v1Ext = v1.ext()
  if (v1Ext.switch() === 2) {
    const v2 = v1Ext.v2()
    extensions.numSponsoring = v2.numSponsoring()
    extensions.numSponsored = v2.numSponsored()
  }
  return extensions
}

/**
 * Reads the collector account plus a trustline entry for every manifest asset,
 * in one round-trip. A trustline that exists but is unauthorized is reported
 * separately: creating it was not enough, and a transfer to it still fails.
 */
async function readAccount(address, assets) {
  const accountKey = accountLedgerKey(address)
  const assetKeys = new Map(
    assets.map((asset) => [
      trustlineLedgerKey(address, asset.code, asset.issuer),
      asset,
    ])
  )
  const entries = await readLedgerEntries([accountKey, ...assetKeys.keys()])

  const accountData = entries.get(accountKey)
  if (accountData === undefined) return { exists: false }

  const account = accountData.account()
  const thresholds = account.thresholds()
  const extensions = readAccountExtensions(account)

  const trustlines = new Map()
  for (const [key, asset] of assetKeys) {
    const data = entries.get(key)
    if (data === undefined) continue
    trustlines.set(asset.contract, {
      authorized: (data.trustLine().flags() & TRUSTLINE_AUTHORIZED) !== 0,
    })
  }

  const subEntries = account.numSubEntries()
  const minimumBalance =
    (2 + subEntries + extensions.numSponsoring - extensions.numSponsored) *
    BASE_RESERVE
  const balance = Number(account.balance().toString()) / STROOPS_PER_XLM

  return {
    exists: true,
    sequence: account.seqNum().toString(),
    balance,
    available:
      balance - minimumBalance - extensions.sellingLiabilities / STROOPS_PER_XLM,
    masterWeight: thresholds[0],
    // ChangeTrust is a medium-threshold operation.
    mediumThreshold: thresholds[2],
    trustlines,
  }
}

// ------------------------------------------------------------- Diffing

/**
 * Classifies every manifest asset against the account. `unauthorized` is the
 * case worth surfacing loudly: the trustline is visibly present, so nothing
 * looks wrong, but the issuer has not authorized it and transfers still fail.
 */
function buildRows(assets, account) {
  return assets.map((asset) => {
    const trustline = account.trustlines.get(asset.contract)
    const status =
      trustline === undefined
        ? 'missing'
        : trustline.authorized
          ? 'present'
          : 'unauthorized'
    return { ...asset, status }
  })
}

const missingRows = (rows) => rows.filter((row) => row.status === 'missing')

/**
 * The rows that will actually be created. Everything missing is selected by
 * default — the common case is "set this account up" — but a partner can
 * narrow it to the assets they expect to receive.
 */
const selectedRows = (rows, selected) =>
  missingRows(rows).filter((row) => selected.has(row.contract))

// ------------------------------------------------- Transaction building

/**
 * Splits the missing assets into transactions. Each is built against the same
 * starting sequence number, so they must be submitted in order, and the account
 * is re-read between submissions rather than pre-chaining the whole set — one
 * failure part-way through would otherwise invalidate every later transaction.
 */
function buildBatches(rows) {
  const batches = []
  for (let i = 0; i < rows.length; i += MAX_OPS_PER_TX) {
    batches.push(rows.slice(i, i + MAX_OPS_PER_TX))
  }
  return batches
}

/**
 * Builds one unsigned transaction. The `changeTrust` limit is left at the SDK
 * default of int64 max, matching the unlimited trustline that the SAC's CAP-73
 * `trust()` would have opened.
 */
function buildTransaction(address, batch, sequence) {
  const builder = new TransactionBuilder(new Account(address, sequence), {
    fee: FEE_PER_OP,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
  for (const asset of batch) {
    builder.addOperation(
      Operation.changeTrust({ asset: new Asset(asset.code, asset.issuer) })
    )
  }
  return builder.setTimeout(600).build()
}

// ------------------------------------------------------------- Wallets

/**
 * Wallet access goes through Stellar Wallets Kit, which covers the injected
 * extensions plus Ledger over WebUSB. Ledger therefore needs a secure context:
 * it works over https and on localhost, but not from a `file://` page.
 *
 * The kit's API is entirely static — `init` once, then call through the class.
 */
function initWallets() {
  const { StellarWalletsKit, modules } = window.LifiWallets
  StellarWalletsKit.init({
    network: NETWORK_PASSPHRASE,
    modules: modules.map((Module) => new Module()),
  })
  return StellarWalletsKit
}

/** Opens the kit's wallet picker and returns the address the user selected. */
async function connectWallet(kit) {
  const { address } = await kit.authModal()
  return address
}

async function disconnectWallet(kit) {
  try {
    await kit.disconnect()
  } catch {
    // Whether the wallet acknowledges the disconnect or not, the page has to
    // stop claiming a connection — the local state is what the UI acts on.
  }
}

/**
 * Signs with the connected wallet. `address` is passed through so the wallet
 * signs with the account being set up rather than whatever it last selected.
 */
async function signTransaction(kit, txXdr, address) {
  const { signedTxXdr } = await kit.signTransaction(txXdr, {
    networkPassphrase: NETWORK_PASSPHRASE,
    address,
  })
  return signedTxXdr
}

// ---------------------------------------------------------- Submission

/** Turns a transaction result XDR into its result code, e.g. `txBadAuth`. */
function describeResult(errorResultXdr) {
  try {
    return xdr.TransactionResult.fromXDR(errorResultXdr, 'base64')
      .result()
      .switch().name
  } catch {
    return 'unknown error'
  }
}

const EXPLANATIONS = {
  txBadAuth: 'Not enough signatures — this account needs more than one signer.',
  txInsufficientBalance:
    'Not enough XLM to cover the reserve for these trustlines.',
  txBadSeq: 'Sequence number is stale — reload and try again.',
  txFailed: 'An operation failed; the most likely cause is an unfunded reserve.',
}

/** Submits a signed transaction and polls until the network reports an outcome. */
async function submitTransaction(signedXdr) {
  const sent = await rpc('sendTransaction', { transaction: signedXdr })
  if (sent.status === 'ERROR') {
    const code = describeResult(sent.errorResultXdr)
    throw new Error(`${code}. ${EXPLANATIONS[code] ?? ''}`.trim())
  }

  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const result = await rpc('getTransaction', { hash: sent.hash })
    if (result.status === 'SUCCESS') return sent.hash
    if (result.status === 'FAILED') {
      const code = describeResult(result.resultXdr)
      throw new Error(`${code}. ${EXPLANATIONS[code] ?? ''}`.trim())
    }
  }
  throw new Error(`Timed out waiting for ${sent.hash}`)
}
