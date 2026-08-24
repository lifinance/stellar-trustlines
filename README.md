# stellar-trustlines
Lets Stellar fee-collector owners create the trustlines LI.FI needs to collect fees, and publishes the token list those trustlines are derived from.
=======
# LI.FI Stellar trustline setup

A fee collector on Stellar must hold a trustline for every asset LI.FI may send
it. Without one, the transfer inside the router's `collect_fees` fails and the
whole route reverts.

This repo publishes the list of those assets and a page that creates the missing
trustlines.

## For partners

Open **https://lifinance.github.io/stellar-trustlines/**, paste your collector
address, and the page shows which trustlines are missing. Connect a wallet to
create them, or download the unsigned transaction and sign it however you
normally do.

Supported wallets: **Ledger** (via WebUSB), Freighter, xBull, Albedo, Rabet,
Lobstr and Hana. Ledger needs a secure context — it works on the hosted page
above and on `localhost`, but not from an HTML file opened off disk.

Everything runs in your browser. No key ever leaves your wallet, and there is no
server involved — the page reads the Stellar network directly.

### Before you start

- **Reserve.** Each trustline locks **0.5 XLM** on your account. The page shows
  the total and refuses to continue if the balance is short.
- **Multisig.** If your account needs more than one signature, the page cannot
  complete the signing flow. It detects this and gives you the XDR instead.
- **Assets marked "Issuer authorization".** Creating the trustline succeeds, but
  the issuer must then authorize it before transfers work. That is a separate
  request to the issuer; see below.

### Assets that need issuer authorization

Some issuers set `AUTH_REQUIRED`, which means a new trustline starts
*unauthorized*. The `ChangeTrust` operation still succeeds and the trustline is
visibly present — but transfers to it fail until the issuer submits
`SetTrustLineFlags` for your account.

Create the trustline anyway: it is the prerequisite, since the issuer can only
authorize a trustline that already exists. Then contact the issuer to be
approved.

## Where the asset list comes from

The page asks the [LI.FI token API](https://li.quest/v1/tokens?chainTypes=STL)
first, so it tracks what LI.FI can actually route today, and falls back to the
`tokens.json` snapshot in this repo when the API cannot answer. It says which of
the two it is showing, under the heading.

The API describes a Stellar token only by its Soroban C-address, but a trustline
needs the classic `CODE:ISSUER` pair. The page resolves that itself, reading the
Stellar Asset Contract's instance storage over the same RPC it uses for
everything else — see `tokens.js`. Tokens with no trustline concept (native XLM,
non-SAC Soroban tokens) and tokens with no price are left out, matching how
`tokens.json` is generated.

It only has to read a contract the snapshot does not already carry, so a list
unchanged since the last export costs no RPC at all. A cached pair is not taken
on faith: a SAC's address is a hash of its code, issuer and network, so the page
re-derives that address locally and drops any pair that does not produce the
contract it is filed under — the same check the on-chain read gets, for no
request. This keeps the page working when RPC is rate-limited, and it is why
`tokens.json` being out of date can only ever cost freshness, never accuracy.

## For anyone scripting against this

`tokens.json` is a published snapshot of that list, and is safe to consume
directly:

```
https://raw.githubusercontent.com/lifinance/stellar-trustlines/main/tokens.json
```

Pin a tag instead of `main` if you need a stable snapshot.

```jsonc
{
  "schemaVersion": 1,
  "network": "public",
  "generatedAt": "2026-08-21T10:50:24.674Z",
  "assets": [
    {
      "code": "USDC",                    // classic asset code
      "issuer": "GA5ZSEJY…",             // issuing account
      "contract": "CCW67TSZ…",           // the asset's Stellar Asset Contract
      "symbol": "USDC",                  // LI.FI display symbol
      "authRequired": false              // issuer gates trustline authorization
    }
  ]
}
```

To check an account yourself: read its trustline ledger entries for each
`code`/`issuer` pair and emit a `ChangeTrust` operation for every one that is
absent. Note that the list only contains classic assets — native XLM and
non-SAC Soroban tokens have no trustline concept and are excluded upstream.

## Running it locally

The page is static, but browser extensions do not inject into `file://` pages
unless you explicitly allow file access. Serving it is more reliable:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Layout

| File | |
| --- | --- |
| `index.html` | the page: markup and styles |
| `tokens.js` | where the asset list comes from: the LI.FI API, or `tokens.json` |
| `stellar.js` | RPC reads, diffing, transaction building, wallets, submission |
| `ui.js` | rendering: the asset table, the summary, status messages |
| `app.js` | the page's state, the actions its buttons trigger, and boot |
| `tokens.json` | the manifest, generated upstream |
| `vendor/bundle.min.js` | built dependencies: Stellar SDK + Stellar Wallets Kit |
| `build/` | the bundle's inputs, so it can be rebuilt and diffed |

Nothing is fetched from a CDN. The four page scripts are plain, readable source,
loaded in that order; only the third-party dependencies are bundled, and
`build/` is there so you can reproduce `vendor/bundle.min.js` yourself:

```bash
cd build && npm install && npm run build
```

Trezor is deliberately excluded — its `@trezor/connect-web` alpha pulls Node
built-ins that cannot be bundled for a browser.

`tokens.json` is generated by `exportStellarTrustlines` in the backend
repository, which resolves each token's C-address to its classic `CODE:ISSUER`
pair by reading the Stellar Asset Contract's instance storage.

## Security

You are being asked to sign transactions from a web page, which is the shape of
a phishing attack. Reasonable precautions:

- **Check the domain.** Only the URL above is ours.
- **Read the source.** All page logic is in `tokens.js`, `stellar.js`, `ui.js`
  and `app.js`; dependencies are bundled from the pinned inputs in `build/`,
  with nothing loaded from a CDN.
- **The asset list cannot lie about an issuer.** Whatever the token list says,
  the `CODE:ISSUER` pair behind each token is read from the asset's contract on
  mainnet and checked by re-deriving the contract address from it. A pair that
  does not derive its own contract is dropped, not offered.
- **Verify the transaction.** Every operation is listed before you sign, and the
  unsigned XDR is always available if you would rather inspect it in
  [Stellar Lab](https://lab.stellar.org).

The only operations this page ever builds are `ChangeTrust`.
