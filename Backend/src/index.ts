import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'

import {
  createRevealHoles,
  getHoleCount,
  getMaxRounds,
  getMultiplier,
  getMultiplierTable,
  getRoundHitChance,
  getRoundChanceTable,
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
const port = Number(process.env.PORT ?? 4000)
const allowedOrigins = process.env.FRONTEND_ORIGIN
  ? process.env.FRONTEND_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
  : [
      'http://localhost:4173',
      'http://127.0.0.1:4173',
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:5174',
      'http://127.0.0.1:5174',
    ]

app.use(
  cors({
    origin: allowedOrigins,
  }),
)
app.use(express.json())

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
    roundChanceTable: getRoundChanceTable(),
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

  if (typeof payload.amount !== 'number' || payload.amount <= 0) {
    response.status(400).json(badRequest('Amount must be a number greater than 0.'))
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

    const { credited, wallet } = creditProcessedTopUp({
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

  const { credited, wallet } = creditProcessedTopUp({
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

  updateWalletBalance(accountId, wallet.balance - betAmount)

  const round: GameRound = {
    id: createRoundId(),
    playerId: accountId,
    accountId,
    betAmount,
    moleCount,
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
  })

  response.status(201).json({
    walletBalance: getOrCreateWallet(accountId).balance,
    round: getPublicRoundState(round),
  })
})

app.post('/api/game/reveal', (request, response) => {
  const { roundId, holeIndex } = request.body as {
    roundId?: unknown
    holeIndex?: unknown
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

  if (round.stage !== 'awaiting-pick') {
    response.status(400).json(badRequest('This round is not waiting for a pick.'))
    return
  }

  const hitChance = getRoundHitChance(round.moleCount, round.currentRound)
  const hit = Math.random() < hitChance
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
    appendHistory(round, 'loss', 0, 0)
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
    updateWalletBalance(round.accountId, wallet.balance + round.payout)
    appendHistory(round, 'max-win', round.multiplier, round.payout)
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
  const { roundId } = request.body as {
    roundId?: unknown
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

  if (round.stage !== 'awaiting-pick' || round.hitCount === 0) {
    response.status(400).json(badRequest('This round cannot be cashed out right now.'))
    return
  }

  round.stage = 'cashed-out'
  saveRound(round)

  const wallet = getOrCreateWallet(round.accountId)
  updateWalletBalance(round.accountId, wallet.balance + round.payout)
  appendHistory(round, 'cashout', round.multiplier, round.payout)
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
  })

  response.json({
    walletBalance: getOrCreateWallet(round.accountId).balance,
    round: getPublicRoundState(round),
  })
})

app.get('/api/game/history', (request, response) => {
  const accountId = getAccountId(request.query.accountId ?? request.query.playerId)

  response.json({
    wallet: accountId ? getOrCreateWallet(accountId) : null,
    rounds: listHistory(accountId ?? undefined),
    transactions: listTransactions(accountId ?? undefined),
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
