# Moles Backend

This is the `Node + TypeScript + Express` backend for the Moles mini-app, built around `Speed Wallet` as the payment rail.

## Scripts

- `npm run dev` starts the API in watch mode
- `npm run build` compiles TypeScript to `dist`
- `npm run start` runs the compiled server

## Environment

Copy `.env.example` to `.env` and add your `Speed` secret API key.

- `SPEED_SECRET_KEY` is required for creating deposits and withdrawals
- Use a `sk_test...` key while building against Speed test mode
- `FRONTEND_ORIGIN` should match your mini-app frontend host
- `LEDGER_FILE_PATH` controls where the local game ledger is stored. The default is `./data/ledger.json`

For deposits to settle into the in-game balance, Speed must be able to reach your webhook endpoint at `POST /api/webhooks/speed/payments`. During local development, expose the backend with a tunnel and register that public URL in your Speed dashboard.

## Endpoints

- `GET /api/health`
- `GET /api/wallet/context`
- `POST /api/wallet/context`
- `POST /api/wallet/deposit-request`
- `POST /api/webhooks/speed/payments`
- `POST /api/game/rounds`
- `POST /api/game/reveal`
- `POST /api/game/cashout`
- `GET /api/game/history`
- `POST /api/wallet/withdraw`
- `POST /api/payouts`

## Speed Wallet Flow

### Deposits

1. Frontend sends the user `acct` to `POST /api/wallet/deposit-request`
2. Backend creates a `Speed payment` object via `POST /payments`
3. Backend returns a Speed mini-app prompt payload with the `payment_request`
4. Frontend sends that JSON to the Speed Wallet webview bridge
5. If no embedded bridge is available, the frontend can still show the raw Lightning invoice as a fallback
6. Speed webhook confirmation credits the in-game balance through `POST /api/webhooks/speed/payments`

### Betting

- Bets are deducted from the app ledger only after a Speed-funded game balance exists
- Round logic stays server-side
- Cashout and max-win credit the in-game balance, not the external wallet directly

### Withdrawals

1. Backend reads the user `p_add` Lightning address from wallet context
2. `POST /api/wallet/withdraw` calls Speed `Instant Send` via `POST /send`
3. App balance is reduced only when the payout request is accepted

## Notes

- Edit `config/game-config.json` to change the multiplier and round chance tables. The backend reloads that file automatically on the next request, even when running the compiled `dist` server.
- Wallets, rounds, payout history, and Speed transaction records are now persisted to `LEDGER_FILE_PATH`, so balances survive backend restarts
- Deposits and withdrawals now depend on real Speed API credentials
- For production, you should persist wallets, rounds, payouts, and webhook events in a database
