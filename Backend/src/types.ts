export type RoundStage = 'awaiting-pick' | 'lost' | 'cashed-out' | 'won-all'

export type RoundHistoryResult = 'loss' | 'cashout' | 'max-win'

export type TransactionKind =
  | 'deposit_request'
  | 'deposit_confirmed'
  | 'bet_placed'
  | 'round_lost'
  | 'cashout'
  | 'max_win'
  | 'withdrawal'

export type TransactionStatus = 'pending' | 'confirmed' | 'completed' | 'failed'

export type TransactionDirection = 'credit' | 'debit'

export interface PlayerWallet {
  playerId: string
  accountId: string
  lightningAddress: string | null
  balance: number
  holdSats: number
  pendingWithdrawal: PendingWithdrawal | null
  lastKnownSpeedBalanceSats: number | null
  createdAt: string
  updatedAt: string
}

export interface PendingWithdrawal {
  withdrawalId: string
  amountSats: number
  requestedAt: string
  reason: string
}

export interface HistoryEntry {
  id: string
  playerId: string
  accountId: string
  roundId: string
  result: RoundHistoryResult
  betAmount: number
  moleCount: number
  roundReached: number
  multiplier: number
  payout: number
  createdAt: string
}

export interface GameRound {
  id: string
  playerId: string
  accountId: string
  betAmount: number
  moleCount: number
  stage: RoundStage
  currentRound: number
  hitCount: number
  payout: number
  multiplier: number
  revealedHistory: Array<{
    round: number
    selectedHole: number
    revealedHoles: number[]
    hit: boolean
  }>
  payoutSent: boolean
  createdAt: string
  updatedAt: string
}

export interface DepositRequest {
  accountId?: string
  amount: number
  currency?: string
  targetCurrency?: 'SATS' | 'USDT' | 'USDC'
  note?: string
}

export interface SpeedContext {
  accountId: string
  lightningAddress: string | null
  lang?: string | null
  balanceBtc?: number | null
  balanceUsdt?: number | null
}

export interface TransactionEntry {
  id: string
  playerId: string
  accountId: string
  roundId: string | null
  externalId: string | null
  kind: TransactionKind
  direction: TransactionDirection
  status: TransactionStatus
  amount: number
  currency: string
  provider: 'speed' | 'internal'
  note: string | null
  metadata: Record<string, unknown>
  createdAt: string
}

export interface SpeedPaymentObject {
  id: string
  status?: string
  currency?: string
  amount?: number
  target_currency?: string
  payment_request?: string
  hosted_invoice_url?: string
  lightning_invoice?: string
  expires_at?: number
  metadata?: Record<string, unknown>
}

export interface SpeedPaymentDetails extends SpeedPaymentObject {
  payment_status?: string
  state?: string
  paid?: boolean
  is_paid?: boolean
  paid_at?: string | number | null
  amount_sats?: number
  target_amount_paid?: number
}

export interface SpeedInstantSendObject {
  id: string
  status?: string
  amount?: number
  currency?: string
  target_currency?: string
  withdraw_method?: string
  withdraw_request?: string
}

export interface SpeedWebhookPayload {
  id?: string
  status?: string
  metadata?: Record<string, unknown>
  target_amount_paid?: number
  amount?: number
  data?: {
    object?: {
      id?: string
      status?: string
      metadata?: Record<string, unknown>
      target_amount_paid?: number
      amount?: number
    }
  }
}
