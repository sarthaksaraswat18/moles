"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const express_1 = __importDefault(require("express"));
const game_1 = require("./game");
const speed_1 = require("./speed");
const store_1 = require("./store");
dotenv_1.default.config();
const app = (0, express_1.default)();
const port = Number(process.env.PORT ?? 4000);
const allowedOrigins = process.env.FRONTEND_ORIGIN
    ? process.env.FRONTEND_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
    : [
        'http://localhost:4173',
        'http://127.0.0.1:4173',
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        'http://localhost:5174',
        'http://127.0.0.1:5174',
    ];
app.use((0, cors_1.default)({
    origin: allowedOrigins,
}));
app.use(express_1.default.json());
function badRequest(message) {
    return {
        error: message,
    };
}
function getAccountId(value) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        return null;
    }
    return value.trim();
}
function getOptionalString(value) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        return null;
    }
    return value.trim();
}
function getOptionalLightningAddress(value) {
    const lightningAddress = getOptionalString(value);
    if (!lightningAddress) {
        return null;
    }
    return (0, speed_1.formatLightningAddress)(lightningAddress);
}
function getOptionalNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}
function getSpeedContext(input) {
    const accountId = getAccountId(input.accountId);
    if (!accountId) {
        return null;
    }
    return {
        accountId,
        lightningAddress: getOptionalLightningAddress(input.lightningAddress ?? input.pAdd),
        lang: getOptionalString(input.lang),
        balanceBtc: getOptionalNumber(input.balBtc),
        balanceUsdt: getOptionalNumber(input.balUsdt),
    };
}
function getWebhookObject(payload) {
    return payload.data?.object ?? payload;
}
function getPublicRoundState(round) {
    const lastReveal = round.revealedHistory[round.revealedHistory.length - 1] ?? null;
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
        maxRounds: (0, game_1.getMaxRounds)(),
        holeCount: (0, game_1.getHoleCount)(),
        lastReveal,
        createdAt: round.createdAt,
        updatedAt: round.updatedAt,
    };
}
app.get('/api/health', (_request, response) => {
    response.json({
        ok: true,
        service: 'moles-backend',
        paymentsRail: 'speed-wallet',
        time: new Date().toISOString(),
    });
});
app.get('/api/game/config', (_request, response) => {
    response.set('Cache-Control', 'no-store');
    response.json({
        holeCount: (0, game_1.getHoleCount)(),
        maxRounds: (0, game_1.getMaxRounds)(),
        multiplierTable: (0, game_1.getMultiplierTable)(),
        roundChanceTable: (0, game_1.getRoundChanceTable)(),
    });
});
app.get('/api/wallet/context', (request, response) => {
    const context = getSpeedContext({
        accountId: request.query.accountId ?? request.query.acct,
        lightningAddress: request.query.lightningAddress,
        pAdd: request.query.p_add,
        lang: request.query.lang,
        balBtc: request.query.bal_btc,
        balUsdt: request.query.bal_usdt,
    });
    if (!context) {
        response.status(400).json(badRequest('Speed Wallet account ID is required.'));
        return;
    }
    const wallet = (0, store_1.syncWalletContext)(context);
    response.json({
        wallet,
        transactions: (0, store_1.listTransactions)(context.accountId),
    });
});
app.post('/api/wallet/context', (request, response) => {
    const context = getSpeedContext({
        accountId: request.body.accountId ?? request.body.acct,
        lightningAddress: request.body.lightningAddress,
        pAdd: request.body.p_add,
        lang: request.body.lang,
        balBtc: request.body.bal_btc,
        balUsdt: request.body.bal_usdt,
    });
    if (!context) {
        response.status(400).json(badRequest('Speed Wallet account ID is required.'));
        return;
    }
    const wallet = (0, store_1.syncWalletContext)(context);
    response.status(201).json({
        wallet,
        transactions: (0, store_1.listTransactions)(context.accountId),
    });
});
app.post('/api/wallet/deposit-request', async (request, response) => {
    const payload = request.body;
    const accountId = getAccountId(payload.accountId);
    if (!accountId) {
        response.status(400).json(badRequest('Speed Wallet account ID is required.'));
        return;
    }
    if (typeof payload.amount !== 'number' || payload.amount <= 0) {
        response.status(400).json(badRequest('Amount must be a number greater than 0.'));
        return;
    }
    const lightningAddress = getOptionalLightningAddress(payload.lightningAddress ?? payload.p_add);
    try {
        if (lightningAddress) {
            (0, store_1.bindWalletLightningAddress)(accountId, lightningAddress);
        }
        const wallet = (0, store_1.getOrCreateWallet)(accountId, lightningAddress);
        const payment = await (0, speed_1.createSpeedDepositPayment)({
            ...payload,
            accountId,
            lightningAddress: wallet.lightningAddress ?? lightningAddress,
        });
        const speedPrompt = (0, speed_1.buildSpeedWalletPrompt)(payment, accountId, payload.amount);
        (0, store_1.appendTransaction)({
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
        });
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
        });
    }
    catch (error) {
        response.status(502).json(badRequest(error instanceof Error ? error.message : 'Unable to create Speed payment.'));
    }
});
app.get('/api/wallet/verify/:invoiceId', async (request, response) => {
    const invoiceId = getOptionalString(request.params.invoiceId);
    const accountId = getAccountId(request.query.accountId);
    if (!invoiceId) {
        response.status(400).json(badRequest('Invoice ID is required.'));
        return;
    }
    if (!accountId) {
        response.status(400).json(badRequest('Speed Wallet account ID is required.'));
        return;
    }
    try {
        const { paid, status, details } = await (0, speed_1.verifyInvoicePaidWithSpeed)(invoiceId);
        if (!paid) {
            response.json({
                ok: true,
                invoiceId,
                paid: false,
                status: status ?? 'unknown',
            });
            return;
        }
        const metadata = details.metadata ?? {};
        const metadataAccountId = getOptionalString(metadata.account_id ?? metadata.Wallet_ID ?? metadata.wallet_id ?? metadata.walletId);
        if (metadataAccountId && metadataAccountId !== accountId) {
            response.status(403).json(badRequest('This invoice belongs to a different wallet.'));
            return;
        }
        const paidAmount = getOptionalNumber(metadata.Amount_SATS ?? metadata.amount_sats) ??
            getOptionalNumber(details.target_amount_paid ?? details.amount ?? details.amount_sats) ??
            0;
        if (paidAmount <= 0) {
            response.status(400).json(badRequest('Paid invoice is missing a valid amount.'));
            return;
        }
        const metadataAddress = getOptionalString(metadata.Lightning_Address ?? metadata.lightning_address);
        if (metadataAddress) {
            (0, store_1.bindWalletLightningAddress)(accountId, metadataAddress);
        }
        const { credited, wallet } = (0, store_1.creditProcessedTopUp)({
            invoiceId,
            accountId,
            amountSats: paidAmount,
        });
        if (credited) {
            (0, store_1.updateTransactionStatus)(invoiceId, 'deposit_request', 'confirmed');
            (0, store_1.appendTransaction)({
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
                metadata: metadata,
            });
        }
        response.json({
            ok: true,
            invoiceId,
            paid: true,
            credited,
            status: status ?? 'paid',
            wallet,
        });
    }
    catch (error) {
        response.status(502).json(badRequest(error instanceof Error ? error.message : 'Unable to verify Speed payment.'));
    }
});
app.post('/api/webhooks/speed/payments', (request, response) => {
    const webhookObject = getWebhookObject(request.body);
    const paymentId = getOptionalString(webhookObject.id);
    const status = getOptionalString(webhookObject.status);
    const metadata = webhookObject.metadata ?? {};
    const accountId = getOptionalString(metadata.account_id);
    const paidAmount = getOptionalNumber(webhookObject.target_amount_paid ?? webhookObject.amount);
    if (!paymentId || !status) {
        response.status(400).json(badRequest('Payment webhook must include id and status.'));
        return;
    }
    if (status.toLowerCase() !== 'paid') {
        (0, store_1.updateTransactionStatus)(paymentId, 'deposit_request', 'pending');
        response.json({ ok: true, ignored: true });
        return;
    }
    if (!accountId || !paidAmount || paidAmount <= 0) {
        response.status(400).json(badRequest('Paid Speed payment must include account_id metadata and amount.'));
        return;
    }
    const metadataAddress = getOptionalString(metadata.lightning_address ?? metadata.Lightning_Address);
    if (metadataAddress) {
        (0, store_1.bindWalletLightningAddress)(accountId, metadataAddress);
    }
    const { credited, wallet } = (0, store_1.creditProcessedTopUp)({
        invoiceId: paymentId,
        accountId,
        amountSats: paidAmount,
    });
    if (!credited) {
        response.json({ ok: true, duplicate: true, wallet: (0, store_1.getOrCreateWallet)(accountId) });
        return;
    }
    (0, store_1.updateTransactionStatus)(paymentId, 'deposit_request', 'confirmed');
    (0, store_1.appendTransaction)({
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
    });
    response.json({
        ok: true,
        wallet,
    });
});
app.post('/api/game/rounds', (request, response) => {
    const { accountId: rawAccountId, betAmount, moleCount, lightningAddress } = request.body;
    const accountId = getAccountId(rawAccountId);
    if (!accountId) {
        response.status(400).json(badRequest('Speed Wallet account ID is required.'));
        return;
    }
    if (typeof betAmount !== 'number' || betAmount <= 0) {
        response.status(400).json(badRequest('Bet amount must be a number greater than 0.'));
        return;
    }
    if (typeof moleCount !== 'number' || moleCount < 1 || moleCount > 6) {
        response.status(400).json(badRequest('Mole count must be between 1 and 6.'));
        return;
    }
    const wallet = (0, store_1.getOrCreateWallet)(accountId, getOptionalLightningAddress(lightningAddress));
    if (wallet.balance < betAmount) {
        response.status(400).json(badRequest('Insufficient balance for this round.'));
        return;
    }
    (0, store_1.updateWalletBalance)(accountId, wallet.balance - betAmount);
    const round = {
        id: (0, store_1.createRoundId)(),
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
    };
    (0, store_1.saveRound)(round);
    (0, store_1.appendTransaction)({
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
    });
    response.status(201).json({
        walletBalance: (0, store_1.getOrCreateWallet)(accountId).balance,
        round: getPublicRoundState(round),
    });
});
app.post('/api/game/reveal', (request, response) => {
    const { roundId, holeIndex } = request.body;
    if (typeof roundId !== 'string' || roundId.trim().length === 0) {
        response.status(400).json(badRequest('Round ID is required.'));
        return;
    }
    if (typeof holeIndex !== 'number' || holeIndex < 0 || holeIndex >= (0, game_1.getHoleCount)()) {
        response.status(400).json(badRequest(`Hole index must be between 0 and ${(0, game_1.getHoleCount)() - 1}.`));
        return;
    }
    const round = (0, store_1.getRound)(roundId);
    if (!round) {
        response.status(404).json(badRequest('Round not found.'));
        return;
    }
    if (round.stage !== 'awaiting-pick') {
        response.status(400).json(badRequest('This round is not waiting for a pick.'));
        return;
    }
    const hitChance = (0, game_1.getRoundHitChance)(round.moleCount, round.currentRound);
    const hit = Math.random() < hitChance;
    const revealedHoles = (0, game_1.createRevealHoles)(round.moleCount, holeIndex, hit);
    round.revealedHistory.push({
        round: round.currentRound,
        selectedHole: holeIndex,
        revealedHoles,
        hit,
    });
    if (!hit) {
        round.stage = 'lost';
        round.multiplier = 0;
        round.payout = 0;
        (0, store_1.saveRound)(round);
        (0, store_1.appendHistory)(round, 'loss', 0, 0);
        (0, store_1.appendTransaction)({
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
        });
        response.json({
            hit: false,
            walletBalance: (0, store_1.getOrCreateWallet)(round.accountId).balance,
            round: getPublicRoundState(round),
        });
        return;
    }
    round.hitCount += 1;
    round.multiplier = (0, game_1.getMultiplier)(round.moleCount, round.hitCount);
    round.payout = Math.floor(round.betAmount * round.multiplier);
    if (round.hitCount >= (0, game_1.getMaxRounds)()) {
        round.stage = 'won-all';
        (0, store_1.saveRound)(round);
        const wallet = (0, store_1.getOrCreateWallet)(round.accountId);
        (0, store_1.updateWalletBalance)(round.accountId, wallet.balance + round.payout);
        (0, store_1.appendHistory)(round, 'max-win', round.multiplier, round.payout);
        (0, store_1.appendTransaction)({
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
        });
        response.json({
            hit: true,
            walletBalance: (0, store_1.getOrCreateWallet)(round.accountId).balance,
            round: getPublicRoundState(round),
        });
        return;
    }
    round.currentRound += 1;
    round.stage = 'awaiting-pick';
    (0, store_1.saveRound)(round);
    response.json({
        hit: true,
        walletBalance: (0, store_1.getOrCreateWallet)(round.accountId).balance,
        round: getPublicRoundState(round),
    });
});
app.post('/api/game/cashout', (request, response) => {
    const { roundId } = request.body;
    if (typeof roundId !== 'string' || roundId.trim().length === 0) {
        response.status(400).json(badRequest('Round ID is required.'));
        return;
    }
    const round = (0, store_1.getRound)(roundId);
    if (!round) {
        response.status(404).json(badRequest('Round not found.'));
        return;
    }
    if (round.stage !== 'awaiting-pick' || round.hitCount === 0) {
        response.status(400).json(badRequest('This round cannot be cashed out right now.'));
        return;
    }
    round.stage = 'cashed-out';
    (0, store_1.saveRound)(round);
    const wallet = (0, store_1.getOrCreateWallet)(round.accountId);
    (0, store_1.updateWalletBalance)(round.accountId, wallet.balance + round.payout);
    (0, store_1.appendHistory)(round, 'cashout', round.multiplier, round.payout);
    (0, store_1.appendTransaction)({
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
    });
    response.json({
        walletBalance: (0, store_1.getOrCreateWallet)(round.accountId).balance,
        round: getPublicRoundState(round),
    });
});
app.get('/api/game/history', (request, response) => {
    const accountId = getAccountId(request.query.accountId ?? request.query.playerId);
    response.json({
        wallet: accountId ? (0, store_1.getOrCreateWallet)(accountId) : null,
        rounds: (0, store_1.listHistory)(accountId ?? undefined),
        transactions: (0, store_1.listTransactions)(accountId ?? undefined),
    });
});
app.get('/api/game/active-round', (request, response) => {
    const accountId = getAccountId(request.query.accountId ?? request.query.playerId);
    if (!accountId) {
        response.status(400).json(badRequest('Speed Wallet account ID is required.'));
        return;
    }
    const round = (0, store_1.getLatestActiveRound)(accountId);
    response.json({
        walletBalance: (0, store_1.getOrCreateWallet)(accountId).balance,
        round: round ? getPublicRoundState(round) : null,
    });
});
async function handleWithdraw(request, response) {
    const { accountId: rawAccountId, amount, lightningAddress: rawLightningAddress, note } = request.body;
    const accountId = getAccountId(rawAccountId);
    if (!accountId) {
        response.status(400).json(badRequest('Speed Wallet account ID is required.'));
        return;
    }
    const normalizedLightningAddress = getOptionalLightningAddress(rawLightningAddress);
    const wallet = (0, store_1.getOrCreateWallet)(accountId, normalizedLightningAddress);
    const lightningAddress = normalizedLightningAddress ?? wallet.lightningAddress;
    if (!lightningAddress || !(0, speed_1.isLightningAddress)(lightningAddress)) {
        response.status(400).json(badRequest('A valid Speed Wallet Lightning address is required.'));
        return;
    }
    try {
        (0, store_1.bindWalletLightningAddress)(accountId, lightningAddress);
    }
    catch (error) {
        response.status(400).json(badRequest(error instanceof Error ? error.message : 'Lightning address mismatch.'));
        return;
    }
    if (wallet.pendingWithdrawal) {
        response.status(400).json(badRequest('Withdrawal already in progress.'));
        return;
    }
    const withdrawAmount = getOptionalNumber(amount) ?? wallet.balance;
    if (!withdrawAmount || withdrawAmount <= 0) {
        response.status(400).json(badRequest('Withdrawal amount must be greater than 0.'));
        return;
    }
    if (wallet.balance < withdrawAmount) {
        response.status(400).json(badRequest('Withdrawal unavailable. App balance is too low to process this payout.'));
        return;
    }
    const balanceBefore = wallet.balance;
    (0, store_1.updateWalletBalance)(accountId, balanceBefore - withdrawAmount);
    (0, store_1.setWalletHold)(accountId, withdrawAmount);
    (0, store_1.setPendingWithdrawal)(accountId, {
        withdrawalId: `wd_${Date.now()}_${accountId.slice(0, 8)}`,
        amountSats: withdrawAmount,
        requestedAt: new Date().toISOString(),
        reason: 'manual_withdraw',
    });
    (0, store_1.appendTransaction)({
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
            recipient: (0, speed_1.formatLightningAddress)(lightningAddress),
            reason: 'manual_withdraw',
        },
    });
    try {
        const payout = await (0, speed_1.createSpeedInstantSend)({
            amount: withdrawAmount,
            lightningAddress,
            note: getOptionalString(note) ?? 'Moles withdrawal',
        });
        (0, store_1.setWalletHold)(accountId, 0);
        (0, store_1.setPendingWithdrawal)(accountId, null);
        const completedWallet = (0, store_1.getOrCreateWallet)(accountId);
        (0, store_1.appendTransaction)({
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
                withdrawRequest: payout.withdraw_request ?? (0, speed_1.formatLightningAddress)(lightningAddress),
                reason: 'manual_withdraw',
            },
        });
        response.status(201).json({
            wallet: completedWallet,
            payout,
        });
    }
    catch (error) {
        (0, store_1.updateWalletBalance)(accountId, balanceBefore);
        (0, store_1.setWalletHold)(accountId, 0);
        (0, store_1.setPendingWithdrawal)(accountId, null);
        response.status(502).json(badRequest(error instanceof Error ? error.message : 'Unable to create Speed payout.'));
    }
}
app.post('/api/wallet/withdraw', handleWithdraw);
app.post('/api/payouts', handleWithdraw);
app.use((error, _request, response, _next) => {
    console.error(error);
    response.status(500).json({
        error: 'Internal server error.',
    });
});
app.listen(port, () => {
    console.log(`Moles backend running on http://localhost:${port}`);
});
