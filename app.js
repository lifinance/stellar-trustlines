/**
 * LI.FI Stellar trustline setup.
 *
 * Reads the published token manifest, diffs it against a collector account's
 * existing trustlines, and builds the `ChangeTrust` operations for whatever is
 * missing. Everything runs in the browser: no backend, no key ever leaves the
 * wallet, and the unsigned XDR is always offered so the transaction can be
 * reviewed or signed elsewhere.
 *
 * This file holds the page's state and the actions the buttons trigger. The
 * network and transaction work lives in `stellar.js`, the rendering in `ui.js`;
 * both are loaded before this one.
 */

/** Everything the page has loaded or derived. */
const state = {
  manifest: null,
  address: null,
  account: null,
  rows: [],
  selected: new Set(),
  kit: null,
  walletAddress: null,
  batches: [],
}

const missing = () => missingRows(state.rows)
const selected = () => selectedRows(state.rows, state.selected)

/** Resets the selection to everything missing, after a load or a submission. */
const selectAllMissing = () => {
  state.selected = new Set(missing().map((row) => row.contract))
}

function render() {
  state.batches = buildBatches(selected())
  renderSummary(state)
  renderTable(state)
  $('results').hidden = false
}

// --------------------------------------------------------------- Actions

async function load(address) {
  if (!isValidAddress(address)) {
    setStatus('That is not a valid Stellar account address (G…).', 'error')
    return
  }
  setStatus('Reading account…')
  try {
    const account = await readAccount(address, state.manifest.assets)
    if (!account.exists) {
      setStatus(
        'That account does not exist on mainnet yet — it needs to be funded first.',
        'error'
      )
      return
    }
    state.address = address
    state.account = account
    state.rows = buildRows(state.manifest.assets, account)
    selectAllMissing()
    render()
    setStatus('')
  } catch (error) {
    setStatus(error.message, 'error')
  }
}

/** Rebuilds every pending transaction and hands back their unsigned XDRs. */
function unsignedXdrs() {
  return state.batches.map((batch) =>
    buildTransaction(state.address, batch, state.account.sequence).toXDR()
  )
}

/**
 * Signs and submits each batch in turn, re-reading the account between them so
 * the next transaction picks up the sequence number the network actually has.
 */
async function signAndSubmit() {
  if (!state.walletAddress) {
    setStatus('Connect a wallet first.', 'error')
    return
  }
  if (selected().length === 0) {
    setStatus('Select at least one asset.', 'error')
    return
  }
  $('sign').disabled = true
  try {
    for (let i = 0; i < state.batches.length; i++) {
      setStatus(`Transaction ${i + 1} of ${state.batches.length}: awaiting signature…`)
      const tx = buildTransaction(
        state.address,
        state.batches[i],
        state.account.sequence
      )
      const signed = await signTransaction(state.kit, tx.toXDR(), state.address)

      setStatus(`Transaction ${i + 1} of ${state.batches.length}: submitting…`)
      const hash = await submitTransaction(signed)
      setStatus(`Transaction ${i + 1} confirmed (${short(hash)}). Re-reading account…`)

      state.account = await readAccount(state.address, state.manifest.assets)
      state.rows = buildRows(state.manifest.assets, state.account)
      // The selection is deliberately left alone: `selectedRows` intersects it
      // with what is still missing, so created assets drop out on their own
      // and anything the partner unchecked stays unchecked.
      render()
    }
    setStatus('Selected trustlines created.', 'ok')
  } catch (error) {
    setStatus(error.message, 'error')
  } finally {
    $('sign').disabled = false
  }
}

/** Drops the connection but keeps the loaded account, so the diff stays put. */
async function dropWallet() {
  await disconnectWallet(state.kit)
  state.walletAddress = null
  renderWalletState(state)
  if (state.account) render()
}

// --------------------------------------------------------------- Wiring

/**
 * The kit renders its own wallet picker, so the page only needs one button.
 * Connecting fills the address field but does not lock it: a signer key is
 * often not the collector account itself.
 */
function wireConnect() {
  $('connect').addEventListener('click', async () => {
    if (state.walletAddress) {
      await dropWallet()
      return
    }
    try {
      const address = await connectWallet(state.kit)
      state.walletAddress = address
      renderWalletState(state)
      if (!$('address').value.trim()) $('address').value = address
      await load($('address').value.trim())
    } catch (error) {
      // The kit throws `{code, message}` when the user dismisses the modal.
      setStatus(error.message ?? 'Wallet connection cancelled.', 'error')
    }
  })
  renderWalletState(state)
}

/**
 * Selection changes are delegated from the container, which is replaced on
 * every render — per-checkbox listeners would not survive it.
 */
function wireSelection() {
  $('assets').addEventListener('change', (event) => {
    const target = event.target
    if (target.id === 'select-all') {
      if (target.checked) selectAllMissing()
      else state.selected.clear()
    } else if (target.dataset?.contract) {
      if (target.checked) state.selected.add(target.dataset.contract)
      else state.selected.delete(target.dataset.contract)
    } else return
    render()
  })
}

function wireActions() {
  $('load').addEventListener('click', () => load($('address').value.trim()))
  $('address').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') load($('address').value.trim())
  })
  $('sign').addEventListener('click', signAndSubmit)
  $('copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(unsignedXdrs().join('\n'))
    setStatus('Unsigned XDR copied.', 'ok')
  })
  $('download').addEventListener('click', () => {
    const blob = new Blob([unsignedXdrs().join('\n')], { type: 'text/plain' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `trustlines-${state.address.slice(0, 8)}.xdr.txt`
    link.click()
    URL.revokeObjectURL(link.href)
  })
}

// ----------------------------------------------------------------- Boot

async function main() {
  try {
    const response = await fetch('./tokens.json')
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    state.manifest = await response.json()
  } catch (error) {
    setStatus(`Could not load tokens.json: ${error.message}`, 'error')
    return
  }

  if (state.manifest.network !== 'public') {
    setStatus(`Manifest is for ${state.manifest.network}, not mainnet.`, 'error')
    return
  }
  renderManifestMeta(state.manifest)

  state.kit = initWallets()
  wireConnect()
  wireSelection()
  wireActions()

  const preset = new URLSearchParams(location.search).get('address')
  if (preset) {
    $('address').value = preset
    await load(preset)
  }
}

main()
