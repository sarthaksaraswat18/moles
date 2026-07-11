"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatLightningAddress = formatLightningAddress;
exports.isLightningAddress = isLightningAddress;
exports.fetchPaymentDetails = fetchPaymentDetails;
exports.verifyInvoicePaidWithSpeed = verifyInvoicePaidWithSpeed;
exports.createLightningInvoice = createLightningInvoice;
exports.createSpeedDepositPayment = createSpeedDepositPayment;
exports.buildSpeedWalletPrompt = buildSpeedWalletPrompt;
exports.createSpeedInstantSend = createSpeedInstantSend;
const buffer_1 = require("buffer");
const SPEED_API_BASE_URL = process.env.SPEED_API_BASE_URL ?? 'https://api.tryspeed.com';
const SPEED_SECRET_KEY = process.env.SPEED_SECRET_KEY ?? process.env.SPEED_WALLET_SECRET_KEY;
const SPEED_PUBLISHABLE_KEY = process.env.SPEED_PUBLISHABLE_KEY ?? process.env.SPEED_WALLET_PUBLISHABLE_KEY;
const SPEED_INVOICE_AUTH_MODE = (process.env.SPEED_INVOICE_AUTH_MODE ?? 'auto').toLowerCase();
function getSecretAuthHeader() {
    if (!SPEED_SECRET_KEY) {
        return null;
    }
    return buffer_1.Buffer.from(`${SPEED_SECRET_KEY}:`).toString('base64');
}
function getPublishableAuthHeader() {
    if (!SPEED_PUBLISHABLE_KEY) {
        return null;
    }
    return buffer_1.Buffer.from(`${SPEED_PUBLISHABLE_KEY}:`).toString('base64');
}
function isBolt11(value) {
    return typeof value === 'string' && value.toLowerCase().startsWith('ln');
}
function extractLightningInvoice(details) {
    const paymentMethodOptions = details.payment_method_options;
    const candidates = [
        paymentMethodOptions?.lightning?.payment_request,
        details.lightning_invoice,
        details.invoice,
        details.payment_request,
        details.bolt11,
    ];
    for (const candidate of candidates) {
        if (isBolt11(candidate)) {
            return candidate;
        }
    }
    return null;
}
async function speedFetch(path, init) {
    const headers = {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Basic ${init.authHeader}`,
        ...init.headers,
    };
    if (init.speedVersion) {
        headers['speed-version'] = '2022-04-15';
    }
    const response = await fetch(`${SPEED_API_BASE_URL}${path}`, {
        ...init,
        headers,
    });
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Speed API request failed (${response.status}): ${errorText}`);
    }
    return (await response.json());
}
function formatLightningAddress(input) {
    const value = String(input || '').trim().toLowerCase();
    if (!value) {
        throw new Error('Lightning address is required');
    }
    if (value.includes('@')) {
        return value;
    }
    return `${value}@speed.app`;
}
function isLightningAddress(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) || /^[^\s@]+@[^\s@]+$/.test(value.trim());
}
async function fetchPaymentDetails(invoiceId) {
    const authHeader = getSecretAuthHeader() ?? getPublishableAuthHeader();
    if (!authHeader) {
        throw new Error('Missing Speed auth key. Set SPEED_SECRET_KEY or SPEED_PUBLISHABLE_KEY.');
    }
    return speedFetch(`/payments/${invoiceId}`, {
        method: 'GET',
        authHeader,
        speedVersion: Boolean(getSecretAuthHeader()),
    });
}
function normalizeSpeedStatus(status) {
    return String(status || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_');
}
function isPaidLikeStatus(status) {
    const normalized = normalizeSpeedStatus(status);
    if (!normalized) {
        return false;
    }
    const tokens = normalized.split(/[._-]+/g).filter(Boolean);
    if (tokens.includes('unpaid') || (tokens.includes('not') && tokens.includes('paid'))) {
        return false;
    }
    const paidTokens = new Set(['paid', 'confirmed', 'succeeded', 'success', 'complete', 'completed']);
    return tokens.some((token) => paidTokens.has(token));
}
async function verifyInvoicePaidWithSpeed(invoiceId) {
    const details = await fetchPaymentDetails(invoiceId);
    const status = details.status ?? details.payment_status ?? details.state ?? null;
    const paidFlag = details.paid === true || details.is_paid === true || details.paid_at != null;
    const paid = Boolean(paidFlag) || isPaidLikeStatus(status);
    return {
        paid,
        status: status ? String(status) : null,
        details,
    };
}
async function attemptCreateInvoice(payload, authHeader, label, speedVersion = false) {
    const data = await speedFetch('/payments', {
        method: 'POST',
        body: JSON.stringify(payload),
        authHeader,
        speedVersion,
    });
    const invoiceId = data.id;
    if (!invoiceId) {
        throw new Error(`[${label}] No invoice ID returned from Speed API`);
    }
    let lightningInvoice = extractLightningInvoice(data);
    const hostedInvoiceUrl = typeof data.hosted_invoice_url === 'string' ? data.hosted_invoice_url : null;
    if (!lightningInvoice) {
        try {
            const details = await fetchPaymentDetails(invoiceId);
            lightningInvoice = extractLightningInvoice(details);
        }
        catch {
            // Best effort only.
        }
    }
    return {
        invoiceId,
        hostedInvoiceUrl,
        lightningInvoice,
        speedInterfaceUrl: hostedInvoiceUrl,
        amountSats: Number(payload.amount) || 0,
        expiresAt: typeof data.expires_at === 'number' ? data.expires_at : null,
        raw: data,
    };
}
async function createLightningInvoice(amountSats, orderId, metadata = {}) {
    if (!Number.isFinite(amountSats) || amountSats <= 0) {
        throw new Error('Invalid amount');
    }
    const mode = SPEED_INVOICE_AUTH_MODE;
    const tryPublishable = mode !== 'secret';
    const trySecret = mode !== 'publishable';
    const publishableHeader = getPublishableAuthHeader();
    const secretHeader = getSecretAuthHeader();
    const payload = {
        currency: 'SATS',
        amount: amountSats,
        target_currency: 'SATS',
        ttl: 600,
        description: `Moles - ${amountSats} SATS`,
        metadata: {
            Order_ID: orderId,
            Game_Type: 'Moles',
            Amount_SATS: String(amountSats),
            ...metadata,
        },
    };
    if (tryPublishable && publishableHeader) {
        try {
            return await attemptCreateInvoice(payload, publishableHeader, 'publishable');
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const shouldFallback = trySecret && /401|403|422/.test(message);
            if (!shouldFallback) {
                throw new Error(`Failed to create invoice (publishable): ${message}`);
            }
        }
    }
    if (trySecret) {
        if (!secretHeader) {
            throw new Error('Missing SPEED_SECRET_KEY');
        }
        try {
            return await attemptCreateInvoice(payload, secretHeader, 'secret', true);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to create invoice (secret): ${message}`);
        }
    }
    throw new Error('No valid invoice auth mode available. Set SPEED_INVOICE_AUTH_MODE to publishable|secret|auto.');
}
async function createSpeedDepositPayment(request) {
    const orderId = `moles_topup_${request.accountId}_${Date.now()}`;
    const formattedAddress = request.lightningAddress ? formatLightningAddress(request.lightningAddress) : null;
    return createLightningInvoice(request.amount, orderId, {
        account_id: request.accountId,
        Wallet_ID: request.accountId,
        Lightning_Address: formattedAddress,
        Purpose: 'topup',
        source: 'moles-mini-app',
        flow: 'deposit',
    });
}
function buildSpeedWalletPrompt(payment, accountId, amount) {
    const paymentRequest = 'lightningInvoice' in payment
        ? payment.lightningInvoice
        : payment.payment_request ?? extractLightningInvoice(payment);
    if (!paymentRequest) {
        throw new Error('Speed payment did not include a Lightning invoice.');
    }
    return {
        version: '2022-10-15',
        account_id: accountId,
        data: {
            amount,
            currency: 'SATS',
            target_currency: 'SATS',
            deposit_address: paymentRequest,
            note: 'Top up Moles game balance',
        },
    };
}
async function createSpeedInstantSend(params) {
    const authHeader = getSecretAuthHeader();
    if (!authHeader) {
        throw new Error('Missing SPEED_SECRET_KEY');
    }
    const withdrawRequest = formatLightningAddress(params.lightningAddress);
    const isLnAddr = withdrawRequest.includes('@');
    return speedFetch('/send', {
        method: 'POST',
        body: JSON.stringify({
            amount: Math.floor(params.amount),
            currency: 'SATS',
            target_currency: 'SATS',
            withdraw_method: 'lightning',
            withdraw_request: withdrawRequest,
            withdraw_type: isLnAddr ? 'lightning_address' : 'lightning_invoice',
            note: String(params.note || '').slice(0, 255),
        }),
        authHeader,
        speedVersion: true,
    });
}
