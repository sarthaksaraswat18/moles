import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { randomUUID } from 'crypto'

import {
  GameRound,
  HistoryEntry,
  PendingWithdrawal,
  PlayerWallet,
  RoundHistoryResult,
  SpeedContext,
  TransactionEntry,
  TransactionKind,
  TransactionStatus,
} from './types'

type ProcessedInvoiceRecord = {
  purpose: string
  walletId: string | null
  amountSats: number
  processedAt: string
}

type PersistedLedger = {
  wallets: Record<string, PlayerWallet>
  rounds: Record<string, GameRound>
  history: HistoryEntry[]
  transactions: TransactionEntry[]
  processedInvoices?: Record<string, ProcessedInvoiceRecord>
}

const ledgerFilePath = process.env.LEDGER_FILE_PATH?.trim()
  ? resolve(process.env.LEDGER_FILE_PATH)
  : resolve(process.cwd(), 'data', 'ledger.json')

function normalizeLightningAddress(lightningAddress?: string | null): string | null {
  const value = String(lightningAddress ?? '').trim().toLowerCase()
  if (!value) {
    return null
  }

  return value.includes('@') ? value : `${value}@speed.app`
}

function createEmptyLedger(): PersistedLedger {
  return {
    wallets: {},
    rounds: {},
    history: [],
    transactions: [],
    processedInvoices: {},
  }
}

function normalizeWallet(wallet: PlayerWallet): PlayerWallet {
  return {
    ...wallet,
    holdSats: Math.max(0, Math.floor(Number(wallet.holdSats) || 0)),
    pendingWithdrawal: wallet.pendingWithdrawal ?? null,
  }
}

function loadLedger(): PersistedLedger {
  try {
    const raw = readFileSync(ledgerFilePath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<PersistedLedger>

    return {
      wallets: parsed.wallets ?? {},
      rounds: parsed.rounds ?? {},
      history: Array.isArray(parsed.history) ? parsed.history : [],
      transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
      processedInvoices: parsed.processedInvoices ?? {},
    }
  } catch (error) {
    const fileError = error as NodeJS.ErrnoException
    if (fileError.code === 'ENOENT') {
      return createEmptyLedger()
    }

    console.warn(`Failed to load ledger from ${ledgerFilePath}. Starting with an empty store.`, error)
    return createEmptyLedger()
  }
}

function persistLedger() {
  const payload: PersistedLedger = {
    wallets: Object.fromEntries(wallets.entries()),
    rounds: Object.fromEntries(rounds.entries()),
    history,
    transactions,
    processedInvoices: Object.fromEntries(processedInvoices.entries()),
  }

  mkdirSync(dirname(ledgerFilePath), { recursive: true })
  writeFileSync(ledgerFilePath, JSON.stringify(payload, null, 2), 'utf8')
}

const persistedLedger = loadLedger()
const wallets = new Map<string, PlayerWallet>(
  Object.entries(persistedLedger.wallets).map(([accountId, wallet]) => [accountId, normalizeWallet(wallet)]),
)
const rounds = new Map<string, GameRound>(Object.entries(persistedLedger.rounds))
const history: HistoryEntry[] = persistedLedger.history
const transactions: TransactionEntry[] = persistedLedger.transactions
const processedInvoices = new Map<string, ProcessedInvoiceRecord>(Object.entries(persistedLedger.processedInvoices ?? {}))

export function getOrCreateWallet(accountId: string, lightningAddress?: string | null): PlayerWallet {
  const normalizedLightningAddress = normalizeLightningAddress(lightningAddress)
  const existing = wallets.get(accountId)
  if (existing) {
    if (normalizedLightningAddress && existing.lightningAddress !== normalizedLightningAddress) {
      existing.lightningAddress = normalizedLightningAddress
      existing.updatedAt = new Date().toISOString()
      wallets.set(accountId, existing)
      persistLedger()
    }
    return existing
  }

  const now = new Date().toISOString()
  const wallet: PlayerWallet = {
    playerId: accountId,
    accountId,
    lightningAddress: normalizedLightningAddress,
    balance: 0,
    holdSats: 0,
    pendingWithdrawal: null,
    lastKnownSpeedBalanceSats: null,
    createdAt: now,
    updatedAt: now,
  }

  wallets.set(accountId, wallet)
  persistLedger()
  return wallet
}

export function syncWalletContext(context: SpeedContext): PlayerWallet {
  const wallet = getOrCreateWallet(context.accountId, context.lightningAddress)
  wallet.lightningAddress = normalizeLightningAddress(context.lightningAddress)
  wallet.lastKnownSpeedBalanceSats = context.balanceBtc ?? wallet.lastKnownSpeedBalanceSats
  wallet.updatedAt = new Date().toISOString()
  wallets.set(context.accountId, wallet)
  persistLedger()
  return wallet
}

export function bindWalletLightningAddress(accountId: string, lightningAddress: string): PlayerWallet {
  const wallet = getOrCreateWallet(accountId)
  const normalized = normalizeLightningAddress(lightningAddress)

  if (!normalized) {
    throw new Error('Lightning address is required')
  }

  if (!wallet.lightningAddress) {
    wallet.lightningAddress = normalized
    wallet.updatedAt = new Date().toISOString()
    wallets.set(accountId, wallet)
    persistLedger()
    return wallet
  }

  const existing = wallet.lightningAddress.trim().toLowerCase()
  const next = normalized
  if (existing !== next) {
    throw new Error('This wallet is bound to a different lightning address')
  }

  return wallet
}

export function setWalletHold(accountId: string, holdSats: number): PlayerWallet {
  const wallet = getOrCreateWallet(accountId)
  wallet.holdSats = Math.max(0, Math.floor(Number(holdSats) || 0))
  wallet.updatedAt = new Date().toISOString()
  wallets.set(accountId, wallet)
  persistLedger()
  return wallet
}

export function setPendingWithdrawal(accountId: string, pendingWithdrawal: PendingWithdrawal | null): PlayerWallet {
  const wallet = getOrCreateWallet(accountId)
  wallet.pendingWithdrawal = pendingWithdrawal
  wallet.updatedAt = new Date().toISOString()
  wallets.set(accountId, wallet)
  persistLedger()
  return wallet
}

export function hasProcessedInvoice(invoiceId: string): boolean {
  return processedInvoices.has(invoiceId)
}

export function creditProcessedTopUp(params: {
  invoiceId: string
  accountId: string
  amountSats: number
}): { credited: boolean; wallet: PlayerWallet } {
  if (processedInvoices.has(params.invoiceId)) {
    return { credited: false, wallet: getOrCreateWallet(params.accountId) }
  }

  const wallet = getOrCreateWallet(params.accountId)
  const nextBalance = wallet.balance + params.amountSats
  wallet.balance = nextBalance
  wallet.updatedAt = new Date().toISOString()
  wallets.set(params.accountId, wallet)

  processedInvoices.set(params.invoiceId, {
    purpose: 'topup',
    walletId: params.accountId,
    amountSats: params.amountSats,
    processedAt: new Date().toISOString(),
  })

  persistLedger()
  return { credited: true, wallet }
}

export function updateWalletBalance(accountId: string, nextBalance: number): PlayerWallet {
  const wallet = getOrCreateWallet(accountId)
  wallet.balance = Math.max(0, Math.floor(Number(nextBalance) || 0))
  wallet.updatedAt = new Date().toISOString()
  wallets.set(accountId, wallet)
  persistLedger()
  return wallet
}

export function saveRound(round: GameRound): GameRound {
  round.updatedAt = new Date().toISOString()
  rounds.set(round.id, round)
  persistLedger()
  return round
}

export function createRoundId(): string {
  return randomUUID()
}

export function createTransactionId(): string {
  return randomUUID()
}

export function getRound(roundId: string): GameRound | undefined {
  return rounds.get(roundId)
}

export function getLatestActiveRound(accountId: string): GameRound | null {
  const activeRounds = Array.from(rounds.values())
    .filter((round) => round.accountId === accountId && round.stage === 'awaiting-pick')
    .sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : -1))

  return activeRounds[0] ?? null
}

export function listTransactions(accountId?: string): TransactionEntry[] {
  return transactions
    .filter((entry) => (accountId ? entry.accountId === accountId : true))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

export function appendTransaction(entry: Omit<TransactionEntry, 'id' | 'createdAt'>): TransactionEntry {
  const transaction: TransactionEntry = {
    id: createTransactionId(),
    createdAt: new Date().toISOString(),
    ...entry,
  }

  transactions.unshift(transaction)
  persistLedger()
  return transaction
}

export function updateTransactionStatus(
  externalId: string,
  kind: TransactionKind,
  status: TransactionStatus,
): TransactionEntry | undefined {
  const transaction = transactions.find(
    (entry) => entry.externalId === externalId && entry.kind === kind,
  )

  if (!transaction) {
    return undefined
  }

  transaction.status = status
  persistLedger()
  return transaction
}

export function listHistory(playerId?: string): HistoryEntry[] {
  return history
    .filter((entry) => (playerId ? entry.playerId === playerId : true))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

export function appendHistory(
  round: GameRound,
  result: RoundHistoryResult,
  multiplier: number,
  payout: number,
): HistoryEntry {
  const entry: HistoryEntry = {
    id: randomUUID(),
    playerId: round.playerId,
    accountId: round.accountId,
    roundId: round.id,
    result,
    betAmount: round.betAmount,
    moleCount: round.moleCount,
    roundReached: round.hitCount,
    multiplier,
    payout,
    createdAt: new Date().toISOString(),
  }

  history.unshift(entry)
  persistLedger()
  return entry
}
