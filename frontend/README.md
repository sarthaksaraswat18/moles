# Moles frontend

This is the `React + TypeScript + Vite` frontend for the `Moles` game. It is designed to run as a `Speed Wallet` mini-app and already supports the full player loop:

- deposit sats through Speed / Lightning
- place bets using the in-game ledger balance
- cash out winnings back into the in-game balance
- withdraw the remaining balance to the player's Lightning address

## Runtime inputs

The app reads Speed mini-app context from the URL when available:

- `acct` or `accountId`
- `p_add` or `lightningAddress`
- `lang`
- `bal_btc`
- `bal_usdt`

If no `acct` is present, the UI falls back to a local dev account in browser storage.

## Environment

Create `.env` from `.env.example`.

- `VITE_API_BASE_URL` should point at the backend API

Default local value:

```env
VITE_API_BASE_URL=http://localhost:4000
```

## Deposit flow

1. Frontend calls `POST /api/wallet/deposit-request`
2. Backend creates a Speed payment and returns a `payment_request`
3. Frontend sends the prompt to the embedded Speed bridge when present
4. If no bridge is available, the frontend shows the Lightning invoice so it can still be paid manually
5. Backend credits the player's game balance when the Speed payment webhook arrives

## Betting and withdrawals

- Bets are placed through `POST /api/game/rounds`
- Reveals and cashouts stay server-driven
- Withdrawals call `POST /api/wallet/withdraw`
- The player's Lightning address comes from `p_add` or manual input

## Local development

```bash
npm install
npm run dev
```

The backend must also be running for balances, deposits, rounds, and withdrawals to work.

## Vercel deploy

Deploy this frontend as a separate Vercel project.

### Vercel settings

- Root Directory: `frontend`
- Framework Preset: `Vite`
- Install Command: `npm install`
- Build Command: `npm run build`
- Output Directory: `dist`

The included `vercel.json` handles the build settings and adds an SPA rewrite so route refreshes still load `index.html`.

### Vercel environment variables

Set these in the Vercel project:

```env
VITE_API_BASE_URL=https://your-render-backend.onrender.com
VITE_LOCK_LN_ADDRESS=1
```

### Render update

After Vercel gives you the live frontend URL, update the backend environment on Render:

```env
FRONTEND_ORIGIN=https://your-app.vercel.app
```

This must match the deployed frontend host exactly or the backend CORS check will block requests.

## Production note

This is still an MVP for real-money play. Before going live, add production-grade authentication, webhook verification, durable database storage, rate limiting, and anti-abuse controls.
