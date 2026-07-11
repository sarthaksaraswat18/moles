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
const ledgerFilePath = process.env.LEDGER_FILE_PATH?.trim()
    ? (0, path_1.resolve)(process.env.LEDGER_FILE_PATH)
    : (0, path_1.resolve)(process.cwd(), 'data', 'ledger.json');
function normalizeLightningAddress(lightningAddress) {
    const value = String(lightningAddress ?? '').trim().toLowerCase();
    if (!value) {
        return null;
    }
    return value.includes('@') ? value : `${value}@speed.app`;
}
function createEmptyLedger() {
    return {
        wallets: {},
        rounds: {},
        history: [],
        transactions: [],
        processedInvoices: {},
    };
}
function normalizeWallet(wallet) {
    return {
        ...wallet,
        holdSats: Math.max(0, Math.floor(Number(wallet.holdSats) || 0)),
        pendingWithdrawal: wallet.pendingWithdrawal ?? null,
    };
}
function loadLedger() {
    try {
        const raw = (0, fs_1.readFileSync)(ledgerFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        return {
            wallets: parsed.wallets ?? {},
            rounds: parsed.rounds ?? {},
            history: Array.isArray(parsed.history) ? parsed.history : [],
            transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
            processedInvoices: parsed.processedInvoices ?? {},
        };
    }
    catch (error) {
        const fileError = error;
        if (fileError.code === 'ENOENT') {
            return createEmptyLedger();
        }
        console.warn(`Failed to load ledger from ${ledgerFilePath}. Starting with an empty store.`, error);
        return createEmptyLedger();
    }
}
function persistLedger() {
    const payload = {
        wallets: Object.fromEntries(wallets.entries()),
        rounds: Object.fromEntries(rounds.entries()),
        history,
        transactions,
        processedInvoices: Object.fromEntries(processedInvoices.entries()),
    };
    (0, fs_1.mkdirSync)((0, path_1.dirname)(ledgerFilePath), { recursive: true });
    (0, fs_1.writeFileSync)(ledgerFilePath, JSON.stringify(payload, null, 2), 'utf8');
}
const persistedLedger = loadLedger();
const wallets = new Map(Object.entries(persistedLedger.wallets).map(([accountId, wallet]) => [accountId, normalizeWallet(wallet)]));
const rounds = new Map(Object.entries(persistedLedger.rounds));
const history = persistedLedger.history;
const transactions = persistedLedger.transactions;
const processedInvoices = new Map(Object.entries(persistedLedger.processedInvoices ?? {}));
function getOrCreateWallet(accountId, lightningAddress) {
    const normalizedLightningAddress = normalizeLightningAddress(lightningAddress);
    const existing = wallets.get(accountId);
    if (existing) {
        if (normalizedLightningAddress && existing.lightningAddress !== normalizedLightningAddress) {
            existing.lightningAddress = normalizedLightningAddress;
            existing.updatedAt = new Date().toISOString();
            wallets.set(accountId, existing);
            persistLedger();
        }
        return existing;
    }
    const now = new Date().toISOString();
    const wallet = {
        playerId: accountId,
        accountId,
        lightningAddress: normalizedLightningAddress,
        balance: 0,
        holdSats: 0,
        pendingWithdrawal: null,
        lastKnownSpeedBalanceSats: null,
        createdAt: now,
        updatedAt: now,
    };
    wallets.set(accountId, wallet);
    persistLedger();
    return wallet;
}
function syncWalletContext(context) {
    const wallet = getOrCreateWallet(context.accountId, context.lightningAddress);
    wallet.lightningAddress = normalizeLightningAddress(context.lightningAddress);
    wallet.lastKnownSpeedBalanceSats = context.balanceBtc ?? wallet.lastKnownSpeedBalanceSats;
    wallet.updatedAt = new Date().toISOString();
    wallets.set(context.accountId, wallet);
    persistLedger();
    return wallet;
}
function bindWalletLightningAddress(accountId, lightningAddress) {
    const wallet = getOrCreateWallet(accountId);
    const normalized = normalizeLightningAddress(lightningAddress);
    if (!normalized) {
        throw new Error('Lightning address is required');
    }
    if (!wallet.lightningAddress) {
        wallet.lightningAddress = normalized;
        wallet.updatedAt = new Date().toISOString();
        wallets.set(accountId, wallet);
        persistLedger();
        return wallet;
    }
    const existing = wallet.lightningAddress.trim().toLowerCase();
    const next = normalized;
    if (existing !== next) {
        throw new Error('This wallet is bound to a different lightning address');
    }
    return wallet;
}
function setWalletHold(accountId, holdSats) {
    const wallet = getOrCreateWallet(accountId);
    wallet.holdSats = Math.max(0, Math.floor(Number(holdSats) || 0));
    wallet.updatedAt = new Date().toISOString();
    wallets.set(accountId, wallet);
    persistLedger();
    return wallet;
}
function setPendingWithdrawal(accountId, pendingWithdrawal) {
    const wallet = getOrCreateWallet(accountId);
    wallet.pendingWithdrawal = pendingWithdrawal;
    wallet.updatedAt = new Date().toISOString();
    wallets.set(accountId, wallet);
    persistLedger();
    return wallet;
}
function hasProcessedInvoice(invoiceId) {
    return processedInvoices.has(invoiceId);
}
function creditProcessedTopUp(params) {
    if (processedInvoices.has(params.invoiceId)) {
        return { credited: false, wallet: getOrCreateWallet(params.accountId) };
    }
    const wallet = getOrCreateWallet(params.accountId);
    const nextBalance = wallet.balance + params.amountSats;
    wallet.balance = nextBalance;
    wallet.updatedAt = new Date().toISOString();
    wallets.set(params.accountId, wallet);
    processedInvoices.set(params.invoiceId, {
        purpose: 'topup',
        walletId: params.accountId,
        amountSats: params.amountSats,
        processedAt: new Date().toISOString(),
    });
    persistLedger();
    return { credited: true, wallet };
}
function updateWalletBalance(accountId, nextBalance) {
    const wallet = getOrCreateWallet(accountId);
    wallet.balance = Math.max(0, Math.floor(Number(nextBalance) || 0));
    wallet.updatedAt = new Date().toISOString();
    wallets.set(accountId, wallet);
    persistLedger();
    return wallet;
}
function saveRound(round) {
    round.updatedAt = new Date().toISOString();
    rounds.set(round.id, round);
    persistLedger();
    return round;
}
function createRoundId() {
    return (0, crypto_1.randomUUID)();
}
function createTransactionId() {
    return (0, crypto_1.randomUUID)();
}
function getRound(roundId) {
    return rounds.get(roundId);
}
function getLatestActiveRound(accountId) {
    const activeRounds = Array.from(rounds.values())
        .filter((round) => round.accountId === accountId && round.stage === 'awaiting-pick')
        .sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : -1));
    return activeRounds[0] ?? null;
}
function listTransactions(accountId) {
    return transactions
        .filter((entry) => (accountId ? entry.accountId === accountId : true))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
function appendTransaction(entry) {
    const transaction = {
        id: createTransactionId(),
        createdAt: new Date().toISOString(),
        ...entry,
    };
    transactions.unshift(transaction);
    persistLedger();
    return transaction;
}
function updateTransactionStatus(externalId, kind, status) {
    const transaction = transactions.find((entry) => entry.externalId === externalId && entry.kind === kind);
    if (!transaction) {
        return undefined;
    }
    transaction.status = status;
    persistLedger();
    return transaction;
}
function listHistory(playerId) {
    return history
        .filter((entry) => (playerId ? entry.playerId === playerId : true))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
function appendHistory(round, result, multiplier, payout) {
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
        createdAt: new Date().toISOString(),
    };
    history.unshift(entry);
    persistLedger();
    return entry;
}
