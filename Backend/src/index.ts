import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import cron from 'node-cron'
import rateLimit from 'express-rate-limit'
import helmet from 'helmet'

import {
  createRevealHoles,
  getHoleCount,
  getMaxRounds,
  getMultiplier,
  getMultiplierTable,
  getRoundHitChance,
} from './game'
import { buildSpeedWalletPrompt, createSpeedDepositPayment, createSpeedInstantSend, formatLightningAddress, isLightningAddress, verifyInvoicePaidWithSpeed } from './speed'
import {
  appendHistory,
  appendTransaction,
  bindWalletLightningAddress,
  createRoundId,
  creditProcessedTopUp,
  getLatestActiveRound,
  getOrCreateWallet,
  getRound,
  listHistory,
  listTransactions,
  saveRound,
  setPendingWithdrawal,
  setWalletHold,
  syncWalletContext,
  updateTransactionStatus,
  updateWalletBalance,
} from './store'
import { DepositRequest, GameRound, SpeedContext, SpeedWebhookPayload } from './types'

dotenv.config()

const app = express()
app.set('trust proxy', 1)
const port = Number(process.env.PORT ?? 4000)
const keepaliveTimeoutMs = Number(process.env.KEEPALIVE_TIMEOUT_MS ?? 10000)
const keepaliveIntervalMinutes = Number(process.env.KEEPALIVE_INTERVAL_MINUTES ?? 5)
const speedWebhookSecret = process.env.SPEED_WEBHOOK_SECRET?.trim() ?? ''
const isProduction = process.env.NODE_ENV === 'production'
const keepaliveUrls = [
  ...(process.env.KEEPALIVE_URL ? process.env.KEEPALIVE_URL.split(',').map((value) => value.trim()).filter(Boolean) : []),
  `http://localhost:${port}/api/health`,
].filter((value, index, array) => array.indexOf(value) === index)

const defaultAllowedOrigins = isProduction
  ? []
  : [
      'http://localhost:4173',
      'http://127.0.0.1:4173',
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:5174',
      'http://127.0.0.1:5174',
    ]
const configuredAllowedOrigins = process.env.FRONTEND_ORIGIN
  ? process.env.FRONTEND_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
  : []
const allowedOrigins = new Set([...defaultAllowedOrigins, ...configuredAllowedOrigins])

function isAllowedOrigin(origin?: string | null): boolean {
  if (!origin) {
    return true
  }

  if (allowedOrigins.has(origin)) {
    return true
  }

  try {
    const { hostname, protocol } = new URL(origin)
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1'

    return !isProduction && protocol === 'http:' && isLocalhost
  } catch {
    return false
  }
}

app.use(
  cors({
    origin: (origin, callback) => {
      callback(null, isAllowedOrigin(origin))
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Speed-Lightning-Address'],
  }),
)
app.use('/api', (_request, response, next) => {
  response.set('Cache-Control', 'no-store')
  next()
})
app.use(helmet())
app.use(express.json({ limit: '32kb' }))
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again shortly.' },
  }),
)

function getRequestLightningAddress(request: express.Request): string | null {
  return getOptionalLightningAddress(
    request.get('x-speed-lightning-address') ??
      request.body?.lightningAddress ??
      request.body?.p_add ??
      request.query.lightningAddress ??
      request.query.p_add,
  )
}

app.use('/api', (request, response, next) => {
  if (!isProduction || request.path === '/health' || request.path === '/game/config' || request.path === '/webhooks/speed/payments') {
    next()
    return
  }

  const requestedAccountId = getAccountId(request.body?.accountId ?? request.query.accountId ?? request.query.playerId)
  const lightningAddress = getRequestLightningAddress(request)
  if (!requestedAccountId || !lightningAddress) {
    response.status(401).json(badRequest('Authenticated Speed Wallet account required.'))
    return
  }

  next()
})

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-XSS-Protection', '1; mode=block')
  next()
})

function pingKeepaliveTarget(url: string): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), keepaliveTimeoutMs)

  return fetch(url, {
    method: 'GET',
    signal: controller.signal,
    headers: {
      'User-Agent': 'moles-keepalive/1.0',
    },
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Ping failed with status ${response.status} for ${url}`)
      }

      return undefined
    })
    .catch((error) => {
      console.warn(`Keepalive ping failed for ${url}:`, error instanceof Error ? error.message : error)
    })
    .finally(() => {
      clearTimeout(timer)
    })
}

async function runKeepaliveCheck(): Promise<void> {
  const targets = keepaliveUrls.length > 0 ? keepaliveUrls : [`http://localhost:${port}/api/health`]

  for (const url of targets) {
    await pingKeepaliveTarget(url)
  }
}

if (Number.isFinite(keepaliveIntervalMinutes) && keepaliveIntervalMinutes > 0) {
  cron.schedule(`*/${Math.max(1, Math.floor(keepaliveIntervalMinutes))} * * * *`, async () => {
    console.log('Running keepalive ping check...')
    await runKeepaliveCheck()
  })
}

function badRequest(message: string) {
  return {
    error: message,
  }
}

function getAccountId(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null
  }

  return value.trim()
}

function getOptionalString(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null
  }

  return value.trim()
}

function getOptionalLightningAddress(value: unknown): string | null {
  const lightningAddress = getOptionalString(value)
  if (!lightningAddress) {
    return null
  }

  return formatLightningAddress(lightningAddress)
}

function getOptionalNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  return null
}

function getSpeedContext(input: {
  accountId?: unknown
  lightningAddress?: unknown
  pAdd?: unknown
  lang?: unknown
  balBtc?: unknown
  balUsdt?: unknown
}): SpeedContext | null {
  const accountId = getAccountId(input.accountId)

  if (!accountId) {
    return null
  }

  return {
    accountId,
    lightningAddress: getOptionalLightningAddress(input.lightningAddress ?? input.pAdd),
    lang: getOptionalString(input.lang),
    balanceBtc: getOptionalNumber(input.balBtc),
    balanceUsdt: getOptionalNumber(input.balUsdt),
  }
}

function getWebhookObject(payload: SpeedWebhookPayload) {
  return payload.data?.object ?? payload
}

function getPublicRoundState(round: GameRound) {
  const lastReveal = round.revealedHistory[round.revealedHistory.length - 1] ?? null

  return {
    id: round.id,
    playerId: round.playerId,
    betAmount: round.betAmount,
    moleCount: round.moleCount,
    stage: round.stage,
    currentRound: round.currentRound,
    hitCount: round.hitCount,
    multiplier: round.multiplier,
    payout: round.payout,
    maxRounds: getMaxRounds(),
    holeCount: getHoleCount(),
    lastReveal,
    createdAt: round.createdAt,
    updatedAt: round.updatedAt,
  }
}

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    service: 'moles-backend',
    paymentsRail: 'speed-wallet',
    time: new Date().toISOString(),
  })
})

app.get('/api/game/config', (_request, response) => {
  response.set('Cache-Control', 'no-store')
  response.json({
    holeCount: getHoleCount(),
    maxRounds: getMaxRounds(),
    multiplierTable: getMultiplierTable(),
  })
})

app.get('/api/wallet/context', (request, response) => {
  const context = getSpeedContext({
    accountId: request.query.accountId ?? request.query.acct,
    lightningAddress: request.query.lightningAddress,
    pAdd: request.query.p_add,
    lang: request.query.lang,
    balBtc: request.query.bal_btc,
    balUsdt: request.query.bal_usdt,
  })

  if (!context) {
    response.status(400).json(badRequest('Speed Wallet account ID is required.'))
    return
  }

  const wallet = syncWalletContext(context)

  response.json({
    wallet,
    transactions: listTransactions(context.accountId),
  })
})

app.post('/api/wallet/context', (request, response) => {
  const context = getSpeedContext({
    accountId: request.body.accountId ?? request.body.acct,
    lightningAddress: request.body.lightningAddress,
    pAdd: request.body.p_add,
    lang: request.body.lang,
    balBtc: request.body.bal_btc,
    balUsdt: request.body.bal_usdt,
  })

  if (!context) {
    response.status(400).json(badRequest('Speed Wallet account ID is required.'))
    return
  }

  const wallet = syncWalletContext(context)

  response.status(201).json({
    wallet,
    transactions: listTransactions(context.accountId),
  })
})

app.post('/api/wallet/deposit-request', async (request, response) => {
  const payload = request.body as DepositRequest & { lightningAddress?: unknown; p_add?: unknown }
  const accountId = getAccountId(payload.accountId)

  if (!accountId) {
    response.status(400).json(badRequest('Speed Wallet account ID is required.'))
    return
  }

  if (typeof payload.amount !== 'number' || !Number.isFinite(payload.amount) || payload.amount < 1000) {
    response.status(400).json(badRequest('Amount must be a number of at least 1,000 sats.'))
    return
  }

  const lightningAddress = getOptionalLightningAddress(payload.lightningAddress ?? payload.p_add)

  try {
    if (lightningAddress) {
      bindWalletLightningAddress(accountId, lightningAddress)
    }

    const wallet = getOrCreateWallet(accountId, lightningAddress)
    const payment = await createSpeedDepositPayment({
      ...payload,
      accountId,
      lightningAddress: wallet.lightningAddress ?? lightningAddress,
    })
    const speedPrompt = buildSpeedWalletPrompt(payment, accountId, payload.amount)

    appendTransaction({
      playerId: accountId,
      accountId,
      roundId: null,
      externalId: payment.invoiceId,
      kind: 'deposit_request',
      direction: 'credit',
      status: 'pending',
      amount: payload.amount,
      currency: payload.currency ?? 'SATS',
      provider: 'speed',
      note: payload.note ?? 'Speed Wallet deposit request created',
      metadata: {
        paymentId: payment.invoiceId,
        expiresAt: payment.expiresAt ?? null,
        lightningAddress: wallet.lightningAddress ?? lightningAddress,
        purpose: 'topup',
      },
      balanceBefore: wallet.balance,
      balanceAfter: wallet.balance,
      lightningAddress: wallet.lightningAddress ?? lightningAddress,
    })

    response.status(201).json({
      wallet,
      speedPayment: payment.raw,
      speedPrompt,
      paymentInfo: {
        invoiceId: payment.invoiceId,
        amountSats: payment.amountSats,
        lightningInvoice: payment.lightningInvoice,
        hostedInvoiceUrl: payment.hostedInvoiceUrl,
        speedInterfaceUrl: payment.speedInterfaceUrl,
        expiresAt: payment.expiresAt,
      },
    })
  } catch (error) {
    response.status(502).json(badRequest(error instanceof Error ? error.message : 'Unable to create Speed payment.'))
  }
})

app.get('/api/wallet/verify/:invoiceId', async (request, response) => {
  const invoiceId = getOptionalString(request.params.invoiceId)
  const accountId = getAccountId(request.query.accountId)

  if (!invoiceId) {
    response.status(400).json(badRequest('Invoice ID is required.'))
    return
  }

  if (!accountId) {
    response.status(400).json(badRequest('Speed Wallet account ID is required.'))
    return
  }

  try {
    const { paid, status, details } = await verifyInvoicePaidWithSpeed(invoiceId)

    if (!paid) {
      response.json({
        ok: true,
        invoiceId,
        paid: false,
        status: status ?? 'unknown',
      })
      return
    }

    const metadata = details.metadata ?? {}
    const metadataAccountId = getOptionalString(
      metadata.account_id ?? metadata.Wallet_ID ?? metadata.wallet_id ?? metadata.walletId,
    )

    if (metadataAccountId && metadataAccountId !== accountId) {
      response.status(403).json(badRequest('This invoice belongs to a different wallet.'))
      return
    }

    const paidAmount =
      getOptionalNumber(metadata.Amount_SATS ?? metadata.amount_sats) ??
      getOptionalNumber(details.target_amount_paid ?? details.amount ?? details.amount_sats) ??
      0

    if (paidAmount <= 0) {
      response.status(400).json(badRequest('Paid invoice is missing a valid amount.'))
      return
    }

    const metadataAddress = getOptionalString(metadata.Lightning_Address ?? metadata.lightning_address)
    if (metadataAddress) {
      bindWalletLightningAddress(accountId, metadataAddress)
    }

    const { credited, wallet, balanceBefore, balanceAfter } = creditProcessedTopUp({
      invoiceId,
      accountId,
      amountSats: paidAmount,
    })

    if (credited) {
      updateTransactionStatus(invoiceId, 'deposit_request', 'confirmed')
      appendTransaction({
        playerId: accountId,
        accountId,
        roundId: null,
        externalId: invoiceId,
        kind: 'deposit_confirmed',
        direction: 'credit',
        status: 'completed',
        amount: paidAmount,
        currency: 'SATS',
        provider: 'speed',
        note: 'Speed payment verified and credited to game balance',
        metadata: metadata as Record<string, unknown>,
        balanceBefore,
        balanceAfter,
        lightningAddress: wallet.lightningAddress ?? null,
      })
    }

    response.json({
      ok: true,
      invoiceId,
      paid: true,
      credited,
      status: status ?? 'paid',
      wallet,
    })
  } catch (error) {
    response.status(502).json(badRequest(error instanceof Error ? error.message : 'Unable to verify Speed payment.'))
  }
})

app.post('/api/webhooks/speed/payments', (request, response) => {
  if (!speedWebhookSecret || request.get('x-speed-webhook-secret') !== speedWebhookSecret) {
    response.status(401).json(badRequest('Webhook authentication failed.'))
    return
  }

  const webhookObject = getWebhookObject(request.body as SpeedWebhookPayload)
  const paymentId = getOptionalString(webhookObject.id)
  const status = getOptionalString(webhookObject.status)
  const metadata = webhookObject.metadata ?? {}
  const accountId = getOptionalString(metadata.account_id)
  const paidAmount = getOptionalNumber(webhookObject.target_amount_paid ?? webhookObject.amount)

  if (!paymentId || !status) {
    response.status(400).json(badRequest('Payment webhook must include id and status.'))
    return
  }

  if (status.toLowerCase() !== 'paid') {
    updateTransactionStatus(paymentId, 'deposit_request', 'pending')
    response.json({ ok: true, ignored: true })
    return
  }

  if (!accountId || !paidAmount || paidAmount <= 0) {
    response.status(400).json(badRequest('Paid Speed payment must include account_id metadata and amount.'))
    return
  }

  const metadataAddress = getOptionalString(metadata.lightning_address ?? metadata.Lightning_Address)
  if (metadataAddress) {
    bindWalletLightningAddress(accountId, metadataAddress)
  }

  const { credited, wallet, balanceBefore, balanceAfter } = creditProcessedTopUp({
    invoiceId: paymentId,
    accountId,
    amountSats: paidAmount,
  })

  if (!credited) {
    response.json({ ok: true, duplicate: true, wallet: getOrCreateWallet(accountId) })
    return
  }

  updateTransactionStatus(paymentId, 'deposit_request', 'confirmed')

  appendTransaction({
    playerId: accountId,
    accountId,
    roundId: null,
    externalId: paymentId,
    kind: 'deposit_confirmed',
    direction: 'credit',
    status: 'completed',
    amount: paidAmount,
    currency: 'SATS',
    provider: 'speed',
    note: 'Speed payment confirmed and credited to game balance',
    metadata,
    balanceBefore,
    balanceAfter,
    lightningAddress: wallet.lightningAddress ?? null,
  })

  response.json({
    ok: true,
    wallet,
  })
})

app.post('/api/game/rounds', (request, response) => {
  const { accountId: rawAccountId, betAmount, moleCount, lightningAddress } = request.body as {
    accountId?: unknown
    betAmount?: unknown
    moleCount?: unknown
    lightningAddress?: unknown
  }

  const accountId = getAccountId(rawAccountId)

  if (!accountId) {
    response.status(400).json(badRequest('Speed Wallet account ID is required.'))
    return
  }

  if (typeof betAmount !== 'number' || betAmount <= 0) {
    response.status(400).json(badRequest('Bet amount must be a number greater than 0.'))
    return
  }

  if (typeof moleCount !== 'number' || moleCount < 1 || moleCount > 6) {
    response.status(400).json(badRequest('Mole count must be between 1 and 6.'))
    return
  }

  const wallet = getOrCreateWallet(accountId, getOptionalLightningAddress(lightningAddress))
  if (wallet.balance < betAmount) {
    response.status(400).json(badRequest('Insufficient balance for this round.'))
    return
  }

  const firstBet = !listTransactions(accountId).some((transaction) => transaction.kind === 'bet_placed')
  updateWalletBalance(accountId, wallet.balance - betAmount)

  const round: GameRound = {
    id: createRoundId(),
    playerId: accountId,
    accountId,
    betAmount,
    moleCount,
    firstBet,
    stage: 'awaiting-pick',
    currentRound: 1,
    hitCount: 0,
    payout: 0,
    multiplier: 0,
    revealedHistory: [],
    payoutSent: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  saveRound(round)
  appendTransaction({
    playerId: accountId,
    accountId,
    roundId: round.id,
    externalId: null,
    kind: 'bet_placed',
    direction: 'debit',
    status: 'completed',
    amount: betAmount,
    currency: 'SATS',
    provider: 'internal',
    note: 'Bet locked from game balance',
    metadata: {
      moleCount,
    },
    balanceBefore: wallet.balance,
    balanceAfter: Math.max(0, wallet.balance - betAmount),
    lightningAddress: wallet.lightningAddress ?? null,
  })

  response.status(201).json({
    walletBalance: getOrCreateWallet(accountId).balance,
    round: getPublicRoundState(round),
  })
})

app.post('/api/game/reveal', (request, response) => {
  const { accountId: rawAccountId, roundId, holeIndex } = request.body as {
    accountId?: unknown
    roundId?: unknown
    holeIndex?: unknown
  }

  const accountId = getAccountId(rawAccountId)

  if (!accountId) {
    response.status(400).json(badRequest('Speed Wallet account ID is required.'))
    return
  }

  if (typeof roundId !== 'string' || roundId.trim().length === 0) {
    response.status(400).json(badRequest('Round ID is required.'))
    return
  }

  if (typeof holeIndex !== 'number' || holeIndex < 0 || holeIndex >= getHoleCount()) {
    response.status(400).json(badRequest(`Hole index must be between 0 and ${getHoleCount() - 1}.`))
    return
  }

  const round = getRound(roundId)
  if (!round) {
    response.status(404).json(badRequest('Round not found.'))
    return
  }

  if (round.accountId !== accountId) {
    response.status(403).json(badRequest('This round belongs to a different wallet.'))
    return
  }

  if (round.stage !== 'awaiting-pick') {
    response.status(400).json(badRequest('This round is not waiting for a pick.'))
    return
  }

  const hitChance = getRoundHitChance(round.moleCount, round.currentRound, round.betAmount)
  const firstBetHitGuaranteed = round.firstBet === true
    && round.currentRound === 1
    && (round.moleCount === 6
      || round.moleCount === 5
      || (round.moleCount === 4 && round.betAmount < 700)
      || (round.moleCount === 3 && round.betAmount < 300))
  const hit = firstBetHitGuaranteed || Math.random() < hitChance
  const revealedHoles = createRevealHoles(round.moleCount, holeIndex, hit)

  round.revealedHistory.push({
    round: round.currentRound,
    selectedHole: holeIndex,
    revealedHoles,
    hit,
  })

  if (!hit) {
    round.stage = 'lost'
    round.multiplier = 0
    round.payout = 0
    saveRound(round)
    const lossWallet = getOrCreateWallet(round.accountId)
    appendHistory(round, 'loss', 0, 0, lossWallet.balance, lossWallet.balance)
    appendTransaction({
      playerId: round.playerId,
      accountId: round.accountId,
      roundId: round.id,
      externalId: null,
      kind: 'round_lost',
      direction: 'debit',
      status: 'completed',
      amount: 0,
      currency: 'SATS',
      provider: 'internal',
      note: 'Round lost',
      metadata: {
        selectedHole: holeIndex,
      },
      balanceBefore: lossWallet.balance,
      balanceAfter: lossWallet.balance,
      lightningAddress: lossWallet.lightningAddress ?? null,
    })

    response.json({
      hit: false,
      walletBalance: getOrCreateWallet(round.accountId).balance,
      round: getPublicRoundState(round),
    })
    return
  }

  round.hitCount += 1
  round.multiplier = getMultiplier(round.moleCount, round.hitCount)
  round.payout = Math.floor(round.betAmount * round.multiplier)

  if (round.hitCount >= getMaxRounds()) {
    round.stage = 'won-all'
    saveRound(round)

    const wallet = getOrCreateWallet(round.accountId)
    const balanceBeforeMaxWin = wallet.balance
    updateWalletBalance(round.accountId, wallet.balance + round.payout)
    const balanceAfterMaxWin = getOrCreateWallet(round.accountId).balance
    appendHistory(round, 'max-win', round.multiplier, round.payout, balanceBeforeMaxWin, balanceAfterMaxWin)
    appendTransaction({
      playerId: round.playerId,
      accountId: round.accountId,
      roundId: round.id,
      externalId: null,
      kind: 'max_win',
      direction: 'credit',
      status: 'completed',
      amount: round.payout,
      currency: 'SATS',
      provider: 'internal',
      note: 'Round completed with max win',
      metadata: {
        hitCount: round.hitCount,
      },
      balanceBefore: balanceBeforeMaxWin,
      balanceAfter: balanceAfterMaxWin,
      lightningAddress: getOrCreateWallet(round.accountId).lightningAddress ?? null,
    })

    response.json({
      hit: true,
      walletBalance: getOrCreateWallet(round.accountId).balance,
      round: getPublicRoundState(round),
    })
    return
  }

  round.currentRound += 1
  round.stage = 'awaiting-pick'
  saveRound(round)

  response.json({
    hit: true,
    walletBalance: getOrCreateWallet(round.accountId).balance,
    round: getPublicRoundState(round),
  })
})

app.post('/api/game/cashout', (request, response) => {
  const { accountId: rawAccountId, roundId } = request.body as {
    accountId?: unknown
    roundId?: unknown
  }

  const accountId = getAccountId(rawAccountId)

  if (!accountId) {
    response.status(400).json(badRequest('Speed Wallet account ID is required.'))
    return
  }

  if (typeof roundId !== 'string' || roundId.trim().length === 0) {
    response.status(400).json(badRequest('Round ID is required.'))
    return
  }

  const round = getRound(roundId)
  if (!round) {
    response.status(404).json(badRequest('Round not found.'))
    return
  }

  if (round.accountId !== accountId) {
    response.status(403).json(badRequest('This round belongs to a different wallet.'))
    return
  }

  if (round.stage !== 'awaiting-pick' || round.hitCount === 0) {
    response.status(400).json(badRequest('This round cannot be cashed out right now.'))
    return
  }

  round.stage = 'cashed-out'
  saveRound(round)

  const wallet = getOrCreateWallet(round.accountId)
  const balanceBeforeCashout = wallet.balance
  updateWalletBalance(round.accountId, wallet.balance + round.payout)
  const balanceAfterCashout = getOrCreateWallet(round.accountId).balance
  appendHistory(round, 'cashout', round.multiplier, round.payout, balanceBeforeCashout, balanceAfterCashout)
  appendTransaction({
    playerId: round.playerId,
    accountId: round.accountId,
    roundId: round.id,
    externalId: null,
    kind: 'cashout',
    direction: 'credit',
    status: 'completed',
    amount: round.payout,
    currency: 'SATS',
    provider: 'internal',
    note: 'Round cashed out to game balance',
    metadata: {
      hitCount: round.hitCount,
    },
    balanceBefore: balanceBeforeCashout,
    balanceAfter: balanceAfterCashout,
    lightningAddress: getOrCreateWallet(round.accountId).lightningAddress ?? null,
  })

  response.json({
    walletBalance: getOrCreateWallet(round.accountId).balance,
    round: getPublicRoundState(round),
  })
})

app.get('/api/game/history', (request, response) => {
  const accountId = getAccountId(request.query.accountId ?? request.query.playerId)

  if (!accountId) {
    response.status(400).json(badRequest('Speed Wallet account ID is required.'))
    return
  }

  response.json({
    wallet: getOrCreateWallet(accountId),
    rounds: listHistory(accountId),
    transactions: listTransactions(accountId),
  })
})

app.get('/api/game/active-round', (request, response) => {
  const accountId = getAccountId(request.query.accountId ?? request.query.playerId)

  if (!accountId) {
    response.status(400).json(badRequest('Speed Wallet account ID is required.'))
    return
  }

  const round = getLatestActiveRound(accountId)

  response.json({
    walletBalance: getOrCreateWallet(accountId).balance,
    round: round ? getPublicRoundState(round) : null,
  })
})

async function handleWithdraw(request: express.Request, response: express.Response) {
  const { accountId: rawAccountId, amount, lightningAddress: rawLightningAddress, note } = request.body as {
    accountId?: unknown
    amount?: unknown
    lightningAddress?: unknown
    note?: unknown
  }

  const accountId = getAccountId(rawAccountId)
  if (!accountId) {
    response.status(400).json(badRequest('Speed Wallet account ID is required.'))
    return
  }

  const normalizedLightningAddress = getOptionalLightningAddress(rawLightningAddress)
  const wallet = getOrCreateWallet(accountId, normalizedLightningAddress)
  const lightningAddress = normalizedLightningAddress ?? wallet.lightningAddress

  if (!lightningAddress || !isLightningAddress(lightningAddress)) {
    response.status(400).json(badRequest('A valid Speed Wallet Lightning address is required.'))
    return
  }

  try {
    bindWalletLightningAddress(accountId, lightningAddress)
  } catch (error) {
    response.status(400).json(badRequest(error instanceof Error ? error.message : 'Lightning address mismatch.'))
    return
  }

  if (wallet.pendingWithdrawal) {
    response.status(400).json(badRequest('Withdrawal already in progress.'))
    return
  }

  const withdrawAmount = getOptionalNumber(amount) ?? wallet.balance
  if (!withdrawAmount || withdrawAmount <= 0) {
    response.status(400).json(badRequest('Withdrawal amount must be greater than 0.'))
    return
  }

  if (wallet.balance < withdrawAmount) {
    response.status(400).json(badRequest('Withdrawal unavailable. App balance is too low to process this payout.'))
    return
  }

  const balanceBefore = wallet.balance
  updateWalletBalance(accountId, balanceBefore - withdrawAmount)
  setWalletHold(accountId, withdrawAmount)
  setPendingWithdrawal(accountId, {
    withdrawalId: `wd_${Date.now()}_${accountId.slice(0, 8)}`,
    amountSats: withdrawAmount,
    requestedAt: new Date().toISOString(),
    reason: 'manual_withdraw',
  })

  appendTransaction({
    playerId: accountId,
    accountId,
    roundId: null,
    externalId: null,
    kind: 'withdrawal',
    direction: 'debit',
    status: 'pending',
    amount: withdrawAmount,
    currency: 'SATS',
    provider: 'speed',
    note: getOptionalString(note) ?? 'Speed Wallet withdrawal requested',
    metadata: {
      recipient: formatLightningAddress(lightningAddress),
      reason: 'manual_withdraw',
    },
    balanceBefore: balanceBefore,
    balanceAfter: Math.max(0, balanceBefore - withdrawAmount),
    lightningAddress: formatLightningAddress(lightningAddress),
  })

  try {
    const payout = await createSpeedInstantSend({
      amount: withdrawAmount,
      lightningAddress,
      note: getOptionalString(note) ?? 'Moles withdrawal',
    })

    setWalletHold(accountId, 0)
    setPendingWithdrawal(accountId, null)

    const completedWallet = getOrCreateWallet(accountId)
    appendTransaction({
      playerId: accountId,
      accountId,
      roundId: null,
      externalId: payout.id,
      kind: 'withdrawal',
      direction: 'debit',
      status: payout.status?.toLowerCase() === 'paid' ? 'completed' : 'confirmed',
      amount: withdrawAmount,
      currency: 'SATS',
      provider: 'speed',
      note: getOptionalString(note) ?? 'Speed Wallet withdrawal sent',
      metadata: {
        withdrawMethod: payout.withdraw_method ?? 'lightning',
        withdrawRequest: payout.withdraw_request ?? formatLightningAddress(lightningAddress),
        reason: 'manual_withdraw',
      },
      balanceBefore: balanceBefore,
      balanceAfter: completedWallet.balance,
      lightningAddress: formatLightningAddress(lightningAddress),
    })

    response.status(201).json({
      wallet: completedWallet,
      payout,
    })
  } catch (error) {
    updateWalletBalance(accountId, balanceBefore)
    setWalletHold(accountId, 0)
    setPendingWithdrawal(accountId, null)

    response.status(502).json(badRequest(error instanceof Error ? error.message : 'Unable to create Speed payout.'))
  }
}

app.post('/api/wallet/withdraw', handleWithdraw)
app.post('/api/payouts', handleWithdraw)

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error(error)
  response.status(500).json({
    error: 'Internal server error.',
  })
})

app.listen(port, () => {
  console.log(`Moles backend running on http://localhost:${port}`)
})
