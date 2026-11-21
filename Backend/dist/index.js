"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const express_1 = __importDefault(require("express"));
const node_cron_1 = __importDefault(require("node-cron"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const helmet_1 = __importDefault(require("helmet"));
const game_1 = require("./game");
const speed_1 = require("./speed");
const store_1 = require("./store");
dotenv_1.default.config();
const app = (0, express_1.default)();
app.set('trust proxy', 1);
const port = Number(process.env.PORT ?? 4000);
const keepaliveTimeoutMs = Number(process.env.KEEPALIVE_TIMEOUT_MS ?? 10000);
const keepaliveIntervalMinutes = Number(process.env.KEEPALIVE_INTERVAL_MINUTES ?? 5);
const speedWebhookSecret = process.env.SPEED_WEBHOOK_SECRET?.trim() ?? '';
const isProduction = process.env.NODE_ENV === 'production';
const keepaliveUrls = [
    ...(process.env.KEEPALIVE_URL ? process.env.KEEPALIVE_URL.split(',').map((value) => value.trim()).filter(Boolean) : []),
    `http://localhost:${port}/api/health`,
].filter((value, index, array) => array.indexOf(value) === index);
const defaultAllowedOrigins = isProduction
    ? []
    : [
        'http://localhost:4173',
        'http://127.0.0.1:4173',
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        'http://localhost:5174',
        'http://127.0.0.1:5174',
    ];
const configuredAllowedOrigins = process.env.FRONTEND_ORIGIN
    ? process.env.FRONTEND_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
    : [];
const allowedOrigins = new Set([...defaultAllowedOrigins, ...configuredAllowedOrigins]);
function isAllowedOrigin(origin) {
    if (!origin) {
        return true;
    }
    if (allowedOrigins.has(origin)) {
        return true;
    }
    try {
        const { hostname, protocol } = new URL(origin);
        const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';
        return !isProduction && protocol === 'http:' && isLocalhost;
    }
    catch {
        return false;
    }
}
app.use((0, cors_1.default)({
    origin: (origin, callback) => {
        callback(null, isAllowedOrigin(origin));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Speed-Lightning-Address'],
}));
app.use('/api', (_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
});
app.use((0, helmet_1.default)());
app.use(express_1.default.json({ limit: '32kb' }));
app.use((0, express_rate_limit_1.default)({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again shortly.' },
}));
function getRequestLightningAddress(request) {
    return getOptionalLightningAddress(request.get('x-speed-lightning-address') ??
        request.body?.lightningAddress ??
        request.body?.p_add ??
        request.query.lightningAddress ??
        request.query.p_add);
}
app.use('/api', (request, response, next) => {
    if (!isProduction || request.path === '/health' || request.path === '/game/config' || request.path === '/webhooks/speed/payments') {
        next();
        return;
    }
    const requestedAccountId = getAccountId(request.body?.accountId ?? request.query.accountId ?? request.query.playerId);
    const lightningAddress = getRequestLightningAddress(request);
    if (!requestedAccountId || !lightningAddress) {
        response.status(401).json(badRequest('Authenticated Speed Wallet account required.'));
        return;
    }
    next();
});
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});
function pingKeepaliveTarget(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), keepaliveTimeoutMs);
    return fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
            'User-Agent': 'moles-keepalive/1.0',
        },
    })
        .then(async (response) => {
        if (!response.ok) {
            throw new Error(`Ping failed with status ${response.status} for ${url}`);
        }
        return undefined;
    })
        .catch((error) => {
        console.warn(`Keepalive ping failed for ${url}:`, error instanceof Error ? error.message : error);
    })
        .finally(() => {
        clearTimeout(timer);
    });
}
async function runKeepaliveCheck() {
    const targets = keepaliveUrls.length > 0 ? keepaliveUrls : [`http://localhost:${port}/api/health`];
    for (const url of targets) {
        await pingKeepaliveTarget(url);
    }
}
if (Number.isFinite(keepaliveIntervalMinutes) && keepaliveIntervalMinutes > 0) {
    node_cron_1.default.schedule(`*/${Math.max(1, Math.floor(keepaliveIntervalMinutes))} * * * *`, async () => {
        console.log('Running keepalive ping check...');
        await runKeepaliveCheck();
    });
}
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
    const logic = (0, game_1.getGameLogicSettings)();
    response.json({
        holeCount: (0, game_1.getHoleCount)(),
        maxRounds: (0, game_1.getMaxRounds)(),
        multiplierTable: (0, game_1.getMultiplierTable)(),
        logicMode: logic.mode,
        rtpTarget: logic.rtpTarget,
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
    if (typeof payload.amount !== 'number' || !Number.isSafeInteger(payload.amount) || payload.amount < 1000) {
        response.status(400).json(badRequest('Amount must be a number of at least 1,000 sats.'));
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
            balanceBefore: wallet.balance,
            balanceAfter: wallet.balance,
            lightningAddress: wallet.lightningAddress ?? lightningAddress,
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
        const { credited, wallet, balanceBefore, balanceAfter } = (0, store_1.creditProcessedTopUp)({
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
                balanceBefore,
                balanceAfter,
                lightningAddress: wallet.lightningAddress ?? null,
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
    if (!speedWebhookSecret || request.get('x-speed-webhook-secret') !== speedWebhookSecret) {
        response.status(401).json(badRequest('Webhook authentication failed.'));
        return;
    }
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
    const { credited, wallet, balanceBefore, balanceAfter } = (0, store_1.creditProcessedTopUp)({
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
        balanceBefore,
        balanceAfter,
        lightningAddress: wallet.lightningAddress ?? null,
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
    if (typeof betAmount !== 'number' || !Number.isSafeInteger(betAmount) || betAmount <= 0) {
        response.status(400).json(badRequest('Bet amount must be a positive whole number of sats.'));
        return;
    }
    if (typeof moleCount !== 'number' || !Number.isInteger(moleCount) || moleCount < 1 || moleCount > 6) {
        response.status(400).json(badRequest('Mole count must be between 1 and 6.'));
        return;
    }
    const wallet = (0, store_1.getOrCreateWallet)(accountId, getOptionalLightningAddress(lightningAddress));
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
    const placement = (0, store_1.placeBet)(round);
    if (!placement.ok) {
        const status = placement.reason === 'active-round' ? 409 : 400;
        const message = placement.reason === 'active-round'
            ? 'Finish or recover your active round before placing another bet.'
            : 'Insufficient balance for this round.';
        response.status(status).json(badRequest(message));
        return;
    }
    response.status(201).json({
        walletBalance: placement.wallet.balance,
        round: getPublicRoundState(placement.round),
    });
});
app.post('/api/game/reveal', (request, response) => {
    const { accountId: rawAccountId, roundId, holeIndex } = request.body;
    const accountId = getAccountId(rawAccountId);
    if (!accountId) {
        response.status(400).json(badRequest('Speed Wallet account ID is required.'));
        return;
    }
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
    if (round.accountId !== accountId) {
        response.status(403).json(badRequest('This round belongs to a different wallet.'));
        return;
    }
    if (round.stage !== 'awaiting-pick') {
        response.status(400).json(badRequest('This round is not waiting for a pick.'));
        return;
    }
    const hitChance = (0, game_1.getRoundHitChance)(round.moleCount, round.currentRound, round.betAmount);
    const firstBetHitGuaranteed = round.firstBet === true
        && round.currentRound === 1
        && (round.moleCount === 6
            || round.moleCount === 5
            || (round.moleCount === 4 && round.betAmount < 700)
            || (round.moleCount === 3 && round.betAmount < 300));
    const hit = firstBetHitGuaranteed || Math.random() < hitChance;
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
        const lossWallet = (0, store_1.getOrCreateWallet)(round.accountId);
        (0, store_1.appendHistory)(round, 'loss', 0, 0, lossWallet.balance, lossWallet.balance);
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
            balanceBefore: lossWallet.balance,
            balanceAfter: lossWallet.balance,
            lightningAddress: lossWallet.lightningAddress ?? null,
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
        const balanceBeforeMaxWin = wallet.balance;
        (0, store_1.updateWalletBalance)(round.accountId, wallet.balance + round.payout);
        const balanceAfterMaxWin = (0, store_1.getOrCreateWallet)(round.accountId).balance;
        (0, store_1.appendHistory)(round, 'max-win', round.multiplier, round.payout, balanceBeforeMaxWin, balanceAfterMaxWin);
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
            balanceBefore: balanceBeforeMaxWin,
            balanceAfter: balanceAfterMaxWin,
            lightningAddress: (0, store_1.getOrCreateWallet)(round.accountId).lightningAddress ?? null,
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
    const { accountId: rawAccountId, roundId } = request.body;
    const accountId = getAccountId(rawAccountId);
    if (!accountId) {
        response.status(400).json(badRequest('Speed Wallet account ID is required.'));
        return;
    }
    if (typeof roundId !== 'string' || roundId.trim().length === 0) {
        response.status(400).json(badRequest('Round ID is required.'));
        return;
    }
    const round = (0, store_1.getRound)(roundId);
    if (!round) {
        response.status(404).json(badRequest('Round not found.'));
        return;
    }
    if (round.accountId !== accountId) {
        response.status(403).json(badRequest('This round belongs to a different wallet.'));
        return;
    }
    if (round.stage !== 'awaiting-pick' || round.hitCount === 0) {
        response.status(400).json(badRequest('This round cannot be cashed out right now.'));
        return;
    }
    round.stage = 'cashed-out';
    (0, store_1.saveRound)(round);
    const wallet = (0, store_1.getOrCreateWallet)(round.accountId);
    const balanceBeforeCashout = wallet.balance;
    (0, store_1.updateWalletBalance)(round.accountId, wallet.balance + round.payout);
    const balanceAfterCashout = (0, store_1.getOrCreateWallet)(round.accountId).balance;
    (0, store_1.appendHistory)(round, 'cashout', round.multiplier, round.payout, balanceBeforeCashout, balanceAfterCashout);
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
        balanceBefore: balanceBeforeCashout,
        balanceAfter: balanceAfterCashout,
        lightningAddress: (0, store_1.getOrCreateWallet)(round.accountId).lightningAddress ?? null,
    });
    response.json({
        walletBalance: (0, store_1.getOrCreateWallet)(round.accountId).balance,
        round: getPublicRoundState(round),
    });
});
app.get('/api/game/history', (request, response) => {
    const accountId = getAccountId(request.query.accountId ?? request.query.playerId);
    if (!accountId) {
        response.status(400).json(badRequest('Speed Wallet account ID is required.'));
        return;
    }
    response.json({
        wallet: (0, store_1.getOrCreateWallet)(accountId),
        rounds: (0, store_1.listHistory)(accountId),
        transactions: (0, store_1.listTransactions)(accountId),
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
    if (!withdrawAmount || !Number.isSafeInteger(withdrawAmount) || withdrawAmount <= 0) {
        response.status(400).json(badRequest('Withdrawal amount must be a positive whole number of sats.'));
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
    const pendingWithdrawalTransaction = (0, store_1.appendTransaction)({
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
        balanceBefore: balanceBefore,
        balanceAfter: Math.max(0, balanceBefore - withdrawAmount),
        lightningAddress: (0, speed_1.formatLightningAddress)(lightningAddress),
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
            balanceBefore: balanceBefore,
            balanceAfter: completedWallet.balance,
            lightningAddress: (0, speed_1.formatLightningAddress)(lightningAddress),
        });
        response.status(201).json({
            wallet: completedWallet,
            payout,
        });
    }
    catch (error) {
        (0, store_1.rollbackFailedWithdrawal)(accountId, withdrawAmount, pendingWithdrawalTransaction.id);
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
