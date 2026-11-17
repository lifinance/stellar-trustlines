# AGENTS.md

A static page that lets Stellar fee-collector owners create the trustlines LI.FI needs to collect fees,
plus the published `tokens.json` asset list those trustlines come from. Everything runs in the browser:
no server, no keys handled by the page. Served by GitHub Pages at
https://lifinance.github.io/stellar-trustlines/.

## Layout

| Path | What lives there |
| --- | --- |
| `index.html` | Markup and styles; loads the scripts below in order |
| `tokens.js` | Asset list: the LI.FI token API first, `tokens.json` as fallback; SAC to `CODE:ISSUER` resolution |
| `stellar.js` | Soroban RPC reads, trustline diffing, transaction building, wallets, submission |
| `ui.js` | Rendering: asset table, summary, status messages |
| `app.js` | Page state, button actions, boot |
| `tokens.json` | Published asset snapshot (schema in README); generated upstream, not edited by hand |
| `vendor/bundle.min.js` | Bundled Stellar SDK and Stellar Wallets Kit (generated) |
| `build/` | Inputs for `vendor/bundle.min.js` (`entry.js`, `shim.js`, `package.json`) |

## Run and build

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. Browser wallets do not inject into `file://` pages, and Ledger needs a
secure context, so serve the page rather than opening the file.

Rebuild the vendored bundle after changing `build/` inputs:

```bash
cd build && npm install && npm run build
```

There are no tests, linters or CI in this repo, and the page reads no environment variables.

## Conventions

- The page only ever builds `ChangeTrust` operations. Keep it that way: partners sign what it builds.
- Nothing loads from a CDN. New dependencies go through `build/` into `vendor/bundle.min.js`.
- A `CODE:ISSUER` pair is trusted only after re-deriving its Stellar Asset Contract address; keep that
  check on every path that produces a pair (see `tokens.js`).
- Trezor is excluded on purpose: its connector pulls Node built-ins that cannot be bundled.

More: [README.md](README.md) (partner guide, `tokens.json` schema, security notes).

## Ownership

- Owner: API Expansion squad, reviewer Daniela (`@melianessa`).
- Review requests: request the reviewer above on the PR.
