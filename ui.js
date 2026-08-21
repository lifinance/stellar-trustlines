/**
 * Everything that writes to the page. Each renderer is handed the page state
 * and derives what it shows from it, so a render is always a function of the
 * state rather than of whatever happened last.
 */

const $ = (id) => document.getElementById(id)

const setStatus = (message, kind = 'info') => {
  const el = $('status')
  el.textContent = message
  el.className = `status ${kind}`
  el.hidden = !message
}

const short = (value) => `${value.slice(0, 6)}…${value.slice(-6)}`

const renderManifestMeta = (manifest) => {
  $('manifest-meta').textContent =
    `${manifest.assets.length} assets · generated ${manifest.generatedAt.slice(0, 10)}`
}

const STATUS_LABEL = {
  missing: 'Missing',
  present: 'Ready',
  unauthorized: 'Needs issuer approval',
}

/** A checkbox for a missing row; a dash for one that is already established. */
function selectCell(row, selected) {
  if (row.status !== 'missing') return '<td></td>'
  const checked = selected.has(row.contract) ? ' checked' : ''
  return `<td><input type="checkbox" data-contract="${row.contract}"
    aria-label="Create trustline for ${row.code}"${checked} /></td>`
}

function renderTable(state) {
  const missing = missingRows(state.rows)
  const allChecked =
    missing.length > 0 &&
    selectedRows(state.rows, state.selected).length === missing.length
  const rows = state.rows
    .map(
      (row) => `
      <tr>
        ${selectCell(row, state.selected)}
        <td><strong>${row.code}</strong></td>
        <td class="mono">${short(row.issuer)}</td>
        <td><span class="pill ${row.status}">${STATUS_LABEL[row.status]}</span></td>
        <td>${row.authRequired ? '<span class="pill gated">Issuer authorization</span>' : ''}</td>
      </tr>`
    )
    .join('')
  $('assets').innerHTML = `
    <table>
      <thead>
        <tr>
          <th>${missing.length > 0 ? `<input type="checkbox" id="select-all" aria-label="Select all missing" ${allChecked ? 'checked' : ''} />` : ''}</th>
          <th>Asset</th><th>Issuer</th><th>Trustline</th><th>Notes</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`
}

/**
 * Renders the summary and decides which actions to offer. A multisig account
 * cannot complete the signing flow in the page, so it is routed to the XDR
 * before it signs anything rather than after a confusing `txBadAuth`.
 */
function renderSummary(state) {
  const missing = missingRows(state.rows)
  const selected = selectedRows(state.rows, state.selected)
  const cost = selected.length * BASE_RESERVE
  const underfunded = state.account.available < cost
  const multisig = state.account.mediumThreshold > state.account.masterWeight

  const notes = []
  if (missing.length === 0) {
    notes.push(
      '<p class="ok">Every asset in the manifest already has a trustline.</p>'
    )
  }
  if (underfunded && selected.length > 0) {
    notes.push(
      `<p class="warn">Not enough XLM: ${selected.length} trustlines lock
       <strong>${cost} XLM</strong> but only
       <strong>${state.account.available.toFixed(2)} XLM</strong> is available.
       Fund the account before continuing.</p>`
    )
  }
  if (multisig) {
    notes.push(
      `<p class="warn">This account needs more than one signature
       (medium threshold ${state.account.mediumThreshold}, master key weight
       ${state.account.masterWeight}). Signing in this page will not be enough —
       download the XDR and sign it through your usual process.</p>`
    )
  }
  if (state.walletAddress && state.walletAddress !== state.address) {
    notes.push(
      `<p class="warn">The connected wallet
       (<span class="mono">${short(state.walletAddress)}</span>) is not this
       account. That is fine if it is a signer on it — otherwise the wallet
       will refuse to sign.</p>`
    )
  }
  const unauthorized = state.rows.filter((r) => r.status === 'unauthorized')
  if (unauthorized.length > 0) {
    notes.push(
      `<p class="warn">${unauthorized.length} trustline(s) exist but are not
       authorized by the issuer: ${unauthorized.map((r) => r.code).join(', ')}.
       Transfers will still fail until the issuer approves them.</p>`
    )
  }

  $('summary').innerHTML = `
    <dl>
      <div><dt>Account</dt><dd class="mono">${state.address}</dd></div>
      <div><dt>Balance</dt><dd>${state.account.balance.toFixed(2)} XLM</dd></div>
      <div><dt>Available</dt><dd>${state.account.available.toFixed(2)} XLM</dd></div>
      <div><dt>Missing trustlines</dt><dd>${missing.length} of ${state.rows.length}</dd></div>
      <div><dt>Selected</dt><dd>${selected.length}</dd></div>
      <div><dt>Reserve needed</dt><dd>${cost} XLM</dd></div>
    </dl>
    ${notes.join('')}`

  const canSign = selected.length > 0 && !underfunded && !multisig
  $('actions').hidden = missing.length === 0
  $('sign').hidden = !canSign
  $('copy').disabled = selected.length === 0
  $('download').disabled = selected.length === 0
  $('sign').textContent =
    state.batches.length > 1
      ? `Create ${selected.length} trustlines (${state.batches.length} transactions)`
      : `Create ${selected.length} trustline${selected.length === 1 ? '' : 's'}`
}

/**
 * Reflects the connection in the button and the address beside it. Without
 * this the button reads "Connect wallet" whether or not one is connected.
 */
function renderWalletState(state) {
  const connected = Boolean(state.walletAddress)
  $('connect').textContent = connected ? 'Disconnect' : 'Connect wallet'
  const badge = $('wallet-status')
  badge.hidden = !connected
  badge.innerHTML = connected
    ? `Signing with <span class="mono">${short(state.walletAddress)}</span>`
    : ''
}
