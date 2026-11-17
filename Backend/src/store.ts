import { existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { randomUUID } from 'crypto'
import { DatabaseSync } from 'node:sqlite'

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

type LegacyLedger = {
  wallets?: Record<string, PlayerWallet>
  rounds?: Record<string, GameRound>
  history?: HistoryEntry[]
  transactions?: TransactionEntry[]
  processedInvoices?: Record<string, { purpose: string; walletId: string | null; amountSats: number; processedAt: string }>
}

export type PlaceBetResult =
  | { ok: true; round: GameRound; wallet: PlayerWallet }
  | { ok: false; reason: 'active-round' | 'insufficient-balance'; wallet: PlayerWallet }

const databasePath = process.env.LEDGER_DB_PATH?.trim()
  ? resolve(process.env.LEDGER_DB_PATH)
  : resolve(process.cwd(), 'data', 'ledger.db')
const legacyLedgerPath = process.env.LEDGER_FILE_PATH?.trim()
  ? resolve(process.env.LEDGER_FILE_PATH)
  : resolve(process.cwd(), 'data', 'ledger.json')

mkdirSync(dirname(databasePath), { recursive: true })
const database = new DatabaseSync(databasePath)
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS wallets (
    account_id TEXT PRIMARY KEY,
    lightning_address TEXT,
    balance INTEGER NOT NULL DEFAULT 0,
    hold_sats INTEGER NOT NULL DEFAULT 0,
    pending_withdrawal_json TEXT,
    last_known_speed_balance_sats REAL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rounds (
    id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    data_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS rounds_account_stage_idx ON rounds(account_id, stage, updated_at DESC);
  CREATE TABLE IF NOT EXISTS history (
    id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    data_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS history_account_created_idx ON history(account_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    external_id TEXT,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    data_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS transactions_account_created_idx ON transactions(account_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS transactions_external_kind_idx ON transactions(external_id, kind);
  CREATE TABLE IF NOT EXISTS processed_invoices (
    invoice_id TEXT PRIMARY KEY,
    purpose TEXT NOT NULL,
    wallet_id TEXT,
    amount_sats INTEGER NOT NULL,
    processed_at TEXT NOT NULL
  );
`)

function normalizeLightningAddress(lightningAddress?: string | null): string | null {
  const value = String(lightningAddress ?? '').trim().toLowerCase()
  if (!value) return null
  return value.includes('@') ? value : `${value}@speed.app`
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T
}

function getWalletRow(accountId: string): Record<string, unknown> | undefined {
  return database.prepare('SELECT * FROM wallets WHERE account_id = ?').get(accountId) as Record<string, unknown> | undefined
}

function toWallet(row: Record<string, unknown>): PlayerWallet {
  return {
    playerId: String(row.account_id),
    accountId: String(row.account_id),
    lightningAddress: (row.lightning_address as string | null) ?? null,
    balance: Number(row.balance) || 0,
    holdSats: Math.max(0, Math.floor(Number(row.hold_sats) || 0)),
    pendingWithdrawal: row.pending_withdrawal_json
      ? parseJson<PendingWithdrawal>(String(row.pending_withdrawal_json))
      : null,
    lastKnownSpeedBalanceSats: row.last_known_speed_balance_sats == null ? null : Number(row.last_known_speed_balance_sats),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function ensureWallet(accountId: string, lightningAddress?: string | null): PlayerWallet {
  const normalized = normalizeLightningAddress(lightningAddress)
  const existingRow = getWalletRow(accountId)
  if (existingRow) {
    const wallet = toWallet(existingRow)
    if (normalized && wallet.lightningAddress !== normalized) {
      const updatedAt = new Date().toISOString()
      database.prepare('UPDATE wallets SET lightning_address = ?, updated_at = ? WHERE account_id = ?')
        .run(normalized, updatedAt, accountId)
      return toWallet(getWalletRow(accountId) as Record<string, unknown>)
    }
    return wallet
  }

  const now = new Date().toISOString()
  database.prepare(`
    INSERT INTO wallets (account_id, lightning_address, balance, hold_sats, pending_withdrawal_json, last_known_speed_balance_sats, created_at, updated_at)
    VALUES (?, ?, 0, 0, NULL, NULL, ?, ?)
  `).run(accountId, normalized, now, now)
  return toWallet(getWalletRow(accountId) as Record<string, unknown>)
}

function importLegacyLedgerIfNeeded(): void {
  const row = database.prepare('SELECT COUNT(*) AS count FROM wallets').get() as { count?: number } | undefined
  if (Number(row?.count ?? 0) > 0 || !existsSync(legacyLedgerPath)) return

  let ledger: LegacyLedger
  try {
    ledger = parseJson<LegacyLedger>(readFileSync(legacyLedgerPath, 'utf8'))
  } catch (error) {
    console.warn(`Unable to import legacy ledger from ${legacyLedgerPath}.`, error)
    return
  }

  database.exec('BEGIN')
  try {
    for (const [accountId, wallet] of Object.entries(ledger.wallets ?? {})) {
      database.prepare(`
        INSERT OR IGNORE INTO wallets (account_id, lightning_address, balance, hold_sats, pending_withdrawal_json, last_known_speed_balance_sats, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        accountId,
        normalizeLightningAddress(wallet.lightningAddress),
        Math.max(0, Math.floor(Number(wallet.balance) || 0)),
        Math.max(0, Math.floor(Number(wallet.holdSats) || 0)),
        wallet.pendingWithdrawal ? JSON.stringify(wallet.pendingWithdrawal) : null,
        wallet.lastKnownSpeedBalanceSats,
        wallet.createdAt,
        wallet.updatedAt,
      )
    }
    for (const round of Object.values(ledger.rounds ?? {})) {
      database.prepare(`INSERT OR IGNORE INTO rounds (id, player_id, account_id, stage, created_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(round.id, round.playerId, round.accountId, round.stage, round.createdAt, round.updatedAt, JSON.stringify(round))
    }
    for (const entry of ledger.history ?? []) {
      database.prepare(`INSERT OR IGNORE INTO history (id, player_id, account_id, created_at, data_json) VALUES (?, ?, ?, ?, ?)`)
        .run(entry.id, entry.playerId, entry.accountId, entry.createdAt, JSON.stringify(entry))
    }
    for (const entry of ledger.transactions ?? []) {
      database.prepare(`INSERT OR IGNORE INTO transactions (id, player_id, account_id, external_id, kind, status, created_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(entry.id, entry.playerId, entry.accountId, entry.externalId, entry.kind, entry.status, entry.createdAt, JSON.stringify(entry))
    }
    for (const [invoiceId, entry] of Object.entries(ledger.processedInvoices ?? {})) {
      database.prepare(`INSERT OR IGNORE INTO processed_invoices (invoice_id, purpose, wallet_id, amount_sats, processed_at) VALUES (?, ?, ?, ?, ?)`)
        .run(invoiceId, entry.purpose, entry.walletId, entry.amountSats, entry.processedAt)
    }
    database.exec('COMMIT')
    console.log(`Imported legacy ledger into SQLite at ${databasePath}.`)
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

importLegacyLedgerIfNeeded()

export function getOrCreateWallet(accountId: string, lightningAddress?: string | null): PlayerWallet {
  return ensureWallet(accountId, lightningAddress)
}

export function closeStore(): void {
  database.close()
}

export function syncWalletContext(context: SpeedContext): PlayerWallet {
  const wallet = ensureWallet(context.accountId, context.lightningAddress)
  database.prepare(`UPDATE wallets SET lightning_address = ?, last_known_speed_balance_sats = ?, updated_at = ? WHERE account_id = ?`)
    .run(normalizeLightningAddress(context.lightningAddress), context.balanceBtc ?? wallet.lastKnownSpeedBalanceSats, new Date().toISOString(), context.accountId)
  return ensureWallet(context.accountId)
}

export function bindWalletLightningAddress(accountId: string, lightningAddress: string): PlayerWallet {
  const wallet = ensureWallet(accountId)
  const normalized = normalizeLightningAddress(lightningAddress)
  if (!normalized) throw new Error('Lightning address is required')
  if (wallet.lightningAddress && wallet.lightningAddress !== normalized) {
    throw new Error('This wallet is bound to a different lightning address')
  }
  if (!wallet.lightningAddress) {
    database.prepare('UPDATE wallets SET lightning_address = ?, updated_at = ? WHERE account_id = ?')
      .run(normalized, new Date().toISOString(), accountId)
  }
  return ensureWallet(accountId)
}

export function setWalletHold(accountId: string, holdSats: number): PlayerWallet {
  ensureWallet(accountId)
  database.prepare('UPDATE wallets SET hold_sats = ?, updated_at = ? WHERE account_id = ?')
    .run(Math.max(0, Math.floor(Number(holdSats) || 0)), new Date().toISOString(), accountId)
  return ensureWallet(accountId)
}

export function setPendingWithdrawal(accountId: string, pendingWithdrawal: PendingWithdrawal | null): PlayerWallet {
  ensureWallet(accountId)
  database.prepare('UPDATE wallets SET pending_withdrawal_json = ?, updated_at = ? WHERE account_id = ?')
    .run(pendingWithdrawal ? JSON.stringify(pendingWithdrawal) : null, new Date().toISOString(), accountId)
  return ensureWallet(accountId)
}

export function hasProcessedInvoice(invoiceId: string): boolean {
  return Boolean(database.prepare('SELECT 1 FROM processed_invoices WHERE invoice_id = ?').get(invoiceId))
}

export function creditProcessedTopUp(params: { invoiceId: string; accountId: string; amountSats: number }): { credited: boolean; wallet: PlayerWallet; balanceBefore: number; balanceAfter: number } {
  database.exec('BEGIN IMMEDIATE')
  try {
    if (hasProcessedInvoice(params.invoiceId)) {
      database.exec('COMMIT')
      const wallet = ensureWallet(params.accountId)
      return { credited: false, wallet, balanceBefore: wallet.balance, balanceAfter: wallet.balance }
    }
    const wallet = ensureWallet(params.accountId)
    const balanceBefore = wallet.balance
    const balanceAfter = balanceBefore + Math.floor(params.amountSats)
    const now = new Date().toISOString()
    database.prepare('UPDATE wallets SET balance = ?, updated_at = ? WHERE account_id = ?').run(balanceAfter, now, params.accountId)
    database.prepare(`INSERT INTO processed_invoices (invoice_id, purpose, wallet_id, amount_sats, processed_at) VALUES (?, 'topup', ?, ?, ?)`)
      .run(params.invoiceId, params.accountId, Math.floor(params.amountSats), now)
    database.exec('COMMIT')
    return { credited: true, wallet: ensureWallet(params.accountId), balanceBefore, balanceAfter }
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

export function updateWalletBalance(accountId: string, nextBalance: number): PlayerWallet {
  ensureWallet(accountId)
  database.prepare('UPDATE wallets SET balance = ?, updated_at = ? WHERE account_id = ?')
    .run(Math.max(0, Math.floor(Number(nextBalance) || 0)), new Date().toISOString(), accountId)
  return ensureWallet(accountId)
}

export function placeBet(round: GameRound): PlaceBetResult {
  database.exec('BEGIN IMMEDIATE')
  try {
    const wallet = ensureWallet(round.accountId)
    const activeRound = database.prepare(`SELECT 1 FROM rounds WHERE account_id = ? AND stage = 'awaiting-pick' LIMIT 1`)
      .get(round.accountId)

    if (activeRound) {
      database.exec('COMMIT')
      return { ok: false, reason: 'active-round', wallet }
    }

    if (wallet.balance < round.betAmount) {
      database.exec('COMMIT')
      return { ok: false, reason: 'insufficient-balance', wallet }
    }

    const existingBet = database.prepare(`SELECT 1 FROM transactions WHERE account_id = ? AND kind = 'bet_placed' LIMIT 1`)
      .get(round.accountId)
    round.firstBet = !existingBet
    const balanceAfter = wallet.balance - round.betAmount
    database.prepare('UPDATE wallets SET balance = ?, updated_at = ? WHERE account_id = ?')
      .run(balanceAfter, new Date().toISOString(), round.accountId)
    saveRound(round)
    appendTransaction({
      playerId: round.playerId,
      accountId: round.accountId,
      roundId: round.id,
      externalId: null,
      kind: 'bet_placed',
      direction: 'debit',
      status: 'completed',
      amount: round.betAmount,
      currency: 'SATS',
      provider: 'internal',
      note: 'Bet locked from game balance',
      metadata: { moleCount: round.moleCount },
      balanceBefore: wallet.balance,
      balanceAfter,
      lightningAddress: wallet.lightningAddress ?? null,
    })
    database.exec('COMMIT')
    return { ok: true, round, wallet: ensureWallet(round.accountId) }
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

export function rollbackFailedWithdrawal(accountId: string, amountSats: number, transactionId: string): PlayerWallet {
  database.exec('BEGIN IMMEDIATE')
  try {
    const wallet = ensureWallet(accountId)
    const nextBalance = wallet.balance + amountSats
    database.prepare(`
      UPDATE wallets
      SET balance = ?, hold_sats = 0, pending_withdrawal_json = NULL, updated_at = ?
      WHERE account_id = ?
    `).run(nextBalance, new Date().toISOString(), accountId)

    const row = database.prepare('SELECT data_json FROM transactions WHERE id = ? AND account_id = ?')
      .get(transactionId, accountId) as { data_json?: string } | undefined
    if (!row?.data_json) {
      throw new Error('Pending withdrawal transaction was not found.')
    }

    const transaction = parseJson<TransactionEntry>(row.data_json)
    transaction.status = 'failed'
    transaction.note = 'Speed Wallet withdrawal failed; reserved sats returned to balance'
    database.prepare('UPDATE transactions SET status = ?, data_json = ? WHERE id = ?')
      .run('failed', JSON.stringify(transaction), transactionId)

    database.exec('COMMIT')
    return ensureWallet(accountId)
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

export function saveRound(round: GameRound): GameRound {
  round.updatedAt = new Date().toISOString()
  database.prepare(`
    INSERT INTO rounds (id, player_id, account_id, stage, created_at, updated_at, data_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET player_id = excluded.player_id, account_id = excluded.account_id, stage = excluded.stage, updated_at = excluded.updated_at, data_json = excluded.data_json
  `).run(round.id, round.playerId, round.accountId, round.stage, round.createdAt, round.updatedAt, JSON.stringify(round))
  return round
}

export function createRoundId(): string { return randomUUID() }
export function createTransactionId(): string { return randomUUID() }

export function getRound(roundId: string): GameRound | undefined {
  const row = database.prepare('SELECT data_json FROM rounds WHERE id = ?').get(roundId) as { data_json?: string } | undefined
  return row?.data_json ? parseJson<GameRound>(row.data_json) : undefined
}

export function getLatestActiveRound(accountId: string): GameRound | null {
  const row = database.prepare(`SELECT data_json FROM rounds WHERE account_id = ? AND stage = 'awaiting-pick' ORDER BY updated_at DESC LIMIT 1`).get(accountId) as { data_json?: string } | undefined
  return row?.data_json ? parseJson<GameRound>(row.data_json) : null
}

export function listTransactions(accountId?: string): TransactionEntry[] {
  const rows = accountId
    ? database.prepare('SELECT data_json FROM transactions WHERE account_id = ? ORDER BY created_at DESC').all(accountId)
    : database.prepare('SELECT data_json FROM transactions ORDER BY created_at DESC').all()
  return (rows as Array<{ data_json: string }>).map((row) => parseJson<TransactionEntry>(row.data_json))
}

export function appendTransaction(entry: Omit<TransactionEntry, 'id' | 'createdAt'>): TransactionEntry {
  const transaction: TransactionEntry = { id: createTransactionId(), createdAt: new Date().toISOString(), ...entry }
  database.prepare(`INSERT INTO transactions (id, player_id, account_id, external_id, kind, status, created_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(transaction.id, transaction.playerId, transaction.accountId, transaction.externalId, transaction.kind, transaction.status, transaction.createdAt, JSON.stringify(transaction))
  return transaction
}

export function updateTransactionStatus(externalId: string, kind: TransactionKind, status: TransactionStatus): TransactionEntry | undefined {
  const row = database.prepare(`SELECT id, data_json FROM transactions WHERE external_id = ? AND kind = ? ORDER BY created_at ASC LIMIT 1`).get(externalId, kind) as { id?: string; data_json?: string } | undefined
  if (!row?.id || !row.data_json) return undefined
  const transaction = parseJson<TransactionEntry>(row.data_json)
  transaction.status = status
  database.prepare('UPDATE transactions SET status = ?, data_json = ? WHERE id = ?').run(status, JSON.stringify(transaction), row.id)
  return transaction
}

export function listHistory(playerId?: string): HistoryEntry[] {
  const rows = playerId
    ? database.prepare('SELECT data_json FROM history WHERE player_id = ? ORDER BY created_at DESC').all(playerId)
    : database.prepare('SELECT data_json FROM history ORDER BY created_at DESC').all()
  return (rows as Array<{ data_json: string }>).map((row) => parseJson<HistoryEntry>(row.data_json))
}

export function appendHistory(round: GameRound, result: RoundHistoryResult, multiplier: number, payout: number, balanceBefore?: number, balanceAfter?: number): HistoryEntry {
  const wallet = ensureWallet(round.accountId)
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
    balanceBefore: typeof balanceBefore === 'number' ? balanceBefore : wallet.balance,
    balanceAfter: typeof balanceAfter === 'number' ? balanceAfter : wallet.balance,
    lightningAddress: wallet.lightningAddress ?? null,
    createdAt: new Date().toISOString(),
  }
  database.prepare('INSERT INTO history (id, player_id, account_id, created_at, data_json) VALUES (?, ?, ?, ?, ?)')
    .run(entry.id, entry.playerId, entry.accountId, entry.createdAt, JSON.stringify(entry))
  return entry
}
