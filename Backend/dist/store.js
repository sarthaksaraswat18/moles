"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOrCreateWallet = getOrCreateWallet;
exports.syncWalletContext = syncWalletContext;
exports.bindWalletLightningAddress = bindWalletLightningAddress;
exports.setWalletHold = setWalletHold;
exports.setPendingWithdrawal = setPendingWithdrawal;
exports.hasProcessedInvoice = hasProcessedInvoice;
exports.creditProcessedTopUp = creditProcessedTopUp;
exports.updateWalletBalance = updateWalletBalance;
exports.saveRound = saveRound;
exports.createRoundId = createRoundId;
exports.createTransactionId = createTransactionId;
exports.getRound = getRound;
exports.getLatestActiveRound = getLatestActiveRound;
exports.listTransactions = listTransactions;
exports.appendTransaction = appendTransaction;
exports.updateTransactionStatus = updateTransactionStatus;
exports.listHistory = listHistory;
exports.appendHistory = appendHistory;
const fs_1 = require("fs");
const path_1 = require("path");
const crypto_1 = require("crypto");
const node_sqlite_1 = require("node:sqlite");
const databasePath = process.env.LEDGER_DB_PATH?.trim()
    ? (0, path_1.resolve)(process.env.LEDGER_DB_PATH)
    : (0, path_1.resolve)(process.cwd(), 'data', 'ledger.db');
const legacyLedgerPath = process.env.LEDGER_FILE_PATH?.trim()
    ? (0, path_1.resolve)(process.env.LEDGER_FILE_PATH)
    : (0, path_1.resolve)(process.cwd(), 'data', 'ledger.json');
(0, fs_1.mkdirSync)((0, path_1.dirname)(databasePath), { recursive: true });
const database = new node_sqlite_1.DatabaseSync(databasePath);
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
`);
function normalizeLightningAddress(lightningAddress) {
    const value = String(lightningAddress ?? '').trim().toLowerCase();
    if (!value)
        return null;
    return value.includes('@') ? value : `${value}@speed.app`;
}
function parseJson(value) {
    return JSON.parse(value);
}
function getWalletRow(accountId) {
    return database.prepare('SELECT * FROM wallets WHERE account_id = ?').get(accountId);
}
function toWallet(row) {
    return {
        playerId: String(row.account_id),
        accountId: String(row.account_id),
        lightningAddress: row.lightning_address ?? null,
        balance: Number(row.balance) || 0,
        holdSats: Math.max(0, Math.floor(Number(row.hold_sats) || 0)),
        pendingWithdrawal: row.pending_withdrawal_json
            ? parseJson(String(row.pending_withdrawal_json))
            : null,
        lastKnownSpeedBalanceSats: row.last_known_speed_balance_sats == null ? null : Number(row.last_known_speed_balance_sats),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
    };
}
function ensureWallet(accountId, lightningAddress) {
    const normalized = normalizeLightningAddress(lightningAddress);
    const existingRow = getWalletRow(accountId);
    if (existingRow) {
        const wallet = toWallet(existingRow);
        if (normalized && wallet.lightningAddress !== normalized) {
            const updatedAt = new Date().toISOString();
            database.prepare('UPDATE wallets SET lightning_address = ?, updated_at = ? WHERE account_id = ?')
                .run(normalized, updatedAt, accountId);
            return toWallet(getWalletRow(accountId));
        }
        return wallet;
    }
    const now = new Date().toISOString();
    database.prepare(`
    INSERT INTO wallets (account_id, lightning_address, balance, hold_sats, pending_withdrawal_json, last_known_speed_balance_sats, created_at, updated_at)
    VALUES (?, ?, 0, 0, NULL, NULL, ?, ?)
  `).run(accountId, normalized, now, now);
    return toWallet(getWalletRow(accountId));
}
function importLegacyLedgerIfNeeded() {
    const row = database.prepare('SELECT COUNT(*) AS count FROM wallets').get();
    if (Number(row?.count ?? 0) > 0 || !(0, fs_1.existsSync)(legacyLedgerPath))
        return;
    let ledger;
    try {
        ledger = parseJson((0, fs_1.readFileSync)(legacyLedgerPath, 'utf8'));
    }
    catch (error) {
        console.warn(`Unable to import legacy ledger from ${legacyLedgerPath}.`, error);
        return;
    }
    database.exec('BEGIN');
    try {
        for (const [accountId, wallet] of Object.entries(ledger.wallets ?? {})) {
            database.prepare(`
        INSERT OR IGNORE INTO wallets (account_id, lightning_address, balance, hold_sats, pending_withdrawal_json, last_known_speed_balance_sats, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(accountId, normalizeLightningAddress(wallet.lightningAddress), Math.max(0, Math.floor(Number(wallet.balance) || 0)), Math.max(0, Math.floor(Number(wallet.holdSats) || 0)), wallet.pendingWithdrawal ? JSON.stringify(wallet.pendingWithdrawal) : null, wallet.lastKnownSpeedBalanceSats, wallet.createdAt, wallet.updatedAt);
        }
        for (const round of Object.values(ledger.rounds ?? {})) {
            database.prepare(`INSERT OR IGNORE INTO rounds (id, player_id, account_id, stage, created_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
                .run(round.id, round.playerId, round.accountId, round.stage, round.createdAt, round.updatedAt, JSON.stringify(round));
        }
        for (const entry of ledger.history ?? []) {
            database.prepare(`INSERT OR IGNORE INTO history (id, player_id, account_id, created_at, data_json) VALUES (?, ?, ?, ?, ?)`)
                .run(entry.id, entry.playerId, entry.accountId, entry.createdAt, JSON.stringify(entry));
        }
        for (const entry of ledger.transactions ?? []) {
            database.prepare(`INSERT OR IGNORE INTO transactions (id, player_id, account_id, external_id, kind, status, created_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(entry.id, entry.playerId, entry.accountId, entry.externalId, entry.kind, entry.status, entry.createdAt, JSON.stringify(entry));
        }
        for (const [invoiceId, entry] of Object.entries(ledger.processedInvoices ?? {})) {
            database.prepare(`INSERT OR IGNORE INTO processed_invoices (invoice_id, purpose, wallet_id, amount_sats, processed_at) VALUES (?, ?, ?, ?, ?)`)
                .run(invoiceId, entry.purpose, entry.walletId, entry.amountSats, entry.processedAt);
        }
        database.exec('COMMIT');
        console.log(`Imported legacy ledger into SQLite at ${databasePath}.`);
    }
    catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
}
importLegacyLedgerIfNeeded();
function getOrCreateWallet(accountId, lightningAddress) {
    return ensureWallet(accountId, lightningAddress);
}
function syncWalletContext(context) {
    const wallet = ensureWallet(context.accountId, context.lightningAddress);
    database.prepare(`UPDATE wallets SET lightning_address = ?, last_known_speed_balance_sats = ?, updated_at = ? WHERE account_id = ?`)
        .run(normalizeLightningAddress(context.lightningAddress), context.balanceBtc ?? wallet.lastKnownSpeedBalanceSats, new Date().toISOString(), context.accountId);
    return ensureWallet(context.accountId);
}
function bindWalletLightningAddress(accountId, lightningAddress) {
    const wallet = ensureWallet(accountId);
    const normalized = normalizeLightningAddress(lightningAddress);
    if (!normalized)
        throw new Error('Lightning address is required');
    if (wallet.lightningAddress && wallet.lightningAddress !== normalized) {
        throw new Error('This wallet is bound to a different lightning address');
    }
    if (!wallet.lightningAddress) {
        database.prepare('UPDATE wallets SET lightning_address = ?, updated_at = ? WHERE account_id = ?')
            .run(normalized, new Date().toISOString(), accountId);
    }
    return ensureWallet(accountId);
}
function setWalletHold(accountId, holdSats) {
    ensureWallet(accountId);
    database.prepare('UPDATE wallets SET hold_sats = ?, updated_at = ? WHERE account_id = ?')
        .run(Math.max(0, Math.floor(Number(holdSats) || 0)), new Date().toISOString(), accountId);
    return ensureWallet(accountId);
}
function setPendingWithdrawal(accountId, pendingWithdrawal) {
    ensureWallet(accountId);
    database.prepare('UPDATE wallets SET pending_withdrawal_json = ?, updated_at = ? WHERE account_id = ?')
        .run(pendingWithdrawal ? JSON.stringify(pendingWithdrawal) : null, new Date().toISOString(), accountId);
    return ensureWallet(accountId);
}
function hasProcessedInvoice(invoiceId) {
    return Boolean(database.prepare('SELECT 1 FROM processed_invoices WHERE invoice_id = ?').get(invoiceId));
}
function creditProcessedTopUp(params) {
    database.exec('BEGIN IMMEDIATE');
    try {
        if (hasProcessedInvoice(params.invoiceId)) {
            database.exec('COMMIT');
            const wallet = ensureWallet(params.accountId);
            return { credited: false, wallet, balanceBefore: wallet.balance, balanceAfter: wallet.balance };
        }
        const wallet = ensureWallet(params.accountId);
        const balanceBefore = wallet.balance;
        const balanceAfter = balanceBefore + Math.floor(params.amountSats);
        const now = new Date().toISOString();
        database.prepare('UPDATE wallets SET balance = ?, updated_at = ? WHERE account_id = ?').run(balanceAfter, now, params.accountId);
        database.prepare(`INSERT INTO processed_invoices (invoice_id, purpose, wallet_id, amount_sats, processed_at) VALUES (?, 'topup', ?, ?, ?)`)
            .run(params.invoiceId, params.accountId, Math.floor(params.amountSats), now);
        database.exec('COMMIT');
        return { credited: true, wallet: ensureWallet(params.accountId), balanceBefore, balanceAfter };
    }
    catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
}
function updateWalletBalance(accountId, nextBalance) {
    ensureWallet(accountId);
    database.prepare('UPDATE wallets SET balance = ?, updated_at = ? WHERE account_id = ?')
        .run(Math.max(0, Math.floor(Number(nextBalance) || 0)), new Date().toISOString(), accountId);
    return ensureWallet(accountId);
}
function saveRound(round) {
    round.updatedAt = new Date().toISOString();
    database.prepare(`
    INSERT INTO rounds (id, player_id, account_id, stage, created_at, updated_at, data_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET player_id = excluded.player_id, account_id = excluded.account_id, stage = excluded.stage, updated_at = excluded.updated_at, data_json = excluded.data_json
  `).run(round.id, round.playerId, round.accountId, round.stage, round.createdAt, round.updatedAt, JSON.stringify(round));
    return round;
}
function createRoundId() { return (0, crypto_1.randomUUID)(); }
function createTransactionId() { return (0, crypto_1.randomUUID)(); }
function getRound(roundId) {
    const row = database.prepare('SELECT data_json FROM rounds WHERE id = ?').get(roundId);
    return row?.data_json ? parseJson(row.data_json) : undefined;
}
function getLatestActiveRound(accountId) {
    const row = database.prepare(`SELECT data_json FROM rounds WHERE account_id = ? AND stage = 'awaiting-pick' ORDER BY updated_at DESC LIMIT 1`).get(accountId);
    return row?.data_json ? parseJson(row.data_json) : null;
}
function listTransactions(accountId) {
    const rows = accountId
        ? database.prepare('SELECT data_json FROM transactions WHERE account_id = ? ORDER BY created_at DESC').all(accountId)
        : database.prepare('SELECT data_json FROM transactions ORDER BY created_at DESC').all();
    return rows.map((row) => parseJson(row.data_json));
}
function appendTransaction(entry) {
    const transaction = { id: createTransactionId(), createdAt: new Date().toISOString(), ...entry };
    database.prepare(`INSERT INTO transactions (id, player_id, account_id, external_id, kind, status, created_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(transaction.id, transaction.playerId, transaction.accountId, transaction.externalId, transaction.kind, transaction.status, transaction.createdAt, JSON.stringify(transaction));
    return transaction;
}
function updateTransactionStatus(externalId, kind, status) {
    const row = database.prepare(`SELECT id, data_json FROM transactions WHERE external_id = ? AND kind = ? ORDER BY created_at ASC LIMIT 1`).get(externalId, kind);
    if (!row?.id || !row.data_json)
        return undefined;
    const transaction = parseJson(row.data_json);
    transaction.status = status;
    database.prepare('UPDATE transactions SET status = ?, data_json = ? WHERE id = ?').run(status, JSON.stringify(transaction), row.id);
    return transaction;
}
function listHistory(playerId) {
    const rows = playerId
        ? database.prepare('SELECT data_json FROM history WHERE player_id = ? ORDER BY created_at DESC').all(playerId)
        : database.prepare('SELECT data_json FROM history ORDER BY created_at DESC').all();
    return rows.map((row) => parseJson(row.data_json));
}
function appendHistory(round, result, multiplier, payout, balanceBefore, balanceAfter) {
    const wallet = ensureWallet(round.accountId);
    const entry = {
        id: (0, crypto_1.randomUUID)(),
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
    };
    database.prepare('INSERT INTO history (id, player_id, account_id, created_at, data_json) VALUES (?, ?, ?, ?, ?)')
        .run(entry.id, entry.playerId, entry.accountId, entry.createdAt, JSON.stringify(entry));
    return entry;
}
