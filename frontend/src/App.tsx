import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import QRCode from 'qrcode'
import './App.css'
import {
  formatDisplayLightningAddress,
  getStoredLightningAddress,
  openPaymentUrlSafely,
  preopenPaymentWindow,
  readLightningAddressFromLocation,
  setStoredLightningAddress,
  setupLightningAddressFetcher,
  shouldForceLockLightningAddress,
} from './walletBridge'

const HOLE_COUNT = 7
const MAX_ROUNDS = 6
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000'
const DEFAULT_BET = 20
const TOP_UP_OPTIONS = [5, 1000, 5000, 10000]
const DEFAULT_MOLES = 3
const LOCAL_DEV_ACCOUNT_STORAGE_KEY = 'moles-speed-local-account'
const MULTIPLIER_TABLE: Record<number, number[]> = {
  1: [10.22, 48.02, 336.14, 2352.98, 16470.86, 115296.02],
  2: [3.43, 12, 42.01, 147.06, 514.71, 1801.5],
  3: [2.28, 5.33, 12.45, 29.04, 67.78, 158.15],
  4: [1.71, 3, 5.25, 9.19, 16.08, 28.14],
  5: [1.27, 1.54, 1.96, 2.18, 3.96, 7.37],
  6: [1.03, 1.14, 1.27, 1.81, 2.11, 2.47],
}
const ROUND_CHANCE_TABLE: Record<number, number[]> = {
  1: [0.0000001, 0.000000001, 0.0000000001, 0.000000000001, 0.00000000001, 0.0000000000000001],
  2: [0.32, 0.25, 0.17, 0.1, 0.001, 0.00001],
  3: [0.35, 0.2, 0.1, 0.001, 0.00008, 0.0001],
  4: [0.57, 0.32, 0.2, 0.12, 0.05, 0.0001],
  5: [0.8, 0.7, 0.57, 0.42, 0.3, 0.0001],
  6: [0.92, 0.82, 1, 0.45, 0.3, 0.25],
}
const TOP_ROW_HOLES = [0, 1]
const MIDDLE_ROW_HOLES = [2, 3, 4]
const BOTTOM_ROW_HOLES = [5, 6]
const MOLE_OPTIONS = [1, 2, 3, 4, 5, 6]
const BET_PRESETS = [20, 100, 300, 500, 1000, 5000, 10000]

type ControlMode = 'manual' | 'auto'
type HoleVisualState = 'hidden' | 'selected' | 'hit' | 'miss' | 'mole-reveal'
type RoundStage = 'setup' | 'awaiting-pick' | 'revealing-hit' | 'lost' | 'cashed-out' | 'won-all'
type WalletSource = 'speed-wallet' | 'local-dev'

type ActiveGame = {
  id: string
  betAmount: number
  moleCount: number
  round: number
  stage: RoundStage
  selectedHole: number | null
  revealedHoles: number[]
  hitCount: number
}

type GameConfigResponse = {
  holeCount?: number
  maxRounds?: number
  multiplierTable?: Record<number, number[]>
  roundChanceTable?: Record<number, number[]>
}

type WalletBootstrapContext = {
  accountId: string
  lightningAddress: string | null
  language: string | null
  balanceBtc: number | null
  balanceUsdt: number | null
  source: WalletSource
}

type BootstrapParamKey = 'acct' | 'accountId' | 'p_add' | 'lightningAddress' | 'lang' | 'bal_btc' | 'bal_usdt'

type PlayerWallet = {
  playerId: string
  accountId: string
  lightningAddress: string | null
  balance: number
  lastKnownSpeedBalanceSats: number | null
  createdAt: string
  updatedAt: string
}

type TransactionEntry = {
  id: string
  accountId: string
  kind: string
  direction: 'credit' | 'debit'
  status: 'pending' | 'confirmed' | 'completed' | 'failed'
  amount: number
  currency: string
  createdAt: string
}

type BackendReveal = {
  round: number
  selectedHole: number
  revealedHoles: number[]
  hit: boolean
}

type BackendRoundStage = 'awaiting-pick' | 'lost' | 'cashed-out' | 'won-all'

type BackendRound = {
  id: string
  playerId: string
  accountId: string
  betAmount: number
  moleCount: number
  stage: BackendRoundStage
  currentRound: number
  hitCount: number
  multiplier: number
  payout: number
  maxRounds: number
  holeCount: number
  lastReveal: BackendReveal | null
  createdAt: string
  updatedAt: string
}

type SpeedPromptPayload = {
  version: string
  account_id: string
  data: {
    amount: number
    currency: string
    target_currency: string
    deposit_address: string
    note: string
  }
}

type SpeedPaymentObject = {
  id: string
  status?: string
  amount?: number
  payment_request?: string
  lightning_invoice?: string
  hosted_invoice_url?: string
  expires_at?: number
  payment_method_options?: {
    lightning?: {
      payment_request?: string
    }
  }
}

type PaymentInfo = {
  invoiceId: string
  amountSats: number
  lightningInvoice: string | null
  hostedInvoiceUrl: string | null
  speedInterfaceUrl: string | null
  expiresAt: number | null
  purpose?: string
}

type VerifyPaymentResponse = {
  ok: boolean
  invoiceId: string
  paid: boolean
  credited?: boolean
  status?: string
  wallet?: PlayerWallet
  error?: string
}

type WalletContextResponse = {
  wallet: PlayerWallet
  transactions: TransactionEntry[]
}

type HistoryResponse = {
  wallet: PlayerWallet | null
  rounds: Array<{
    id: string
    result: string
    roundId: string
    multiplier: number
    payout: number
    createdAt: string
  }>
  transactions: TransactionEntry[]
}

type ActiveRoundResponse = {
  walletBalance: number
  round: BackendRound | null
}

type RoundMutationResponse = {
  walletBalance: number
  round: BackendRound
  hit?: boolean
}

type DepositResponse = {
  wallet: PlayerWallet
  speedPayment: SpeedPaymentObject
  speedPrompt: SpeedPromptPayload
  paymentInfo?: PaymentInfo
}

type WithdrawResponse = {
  wallet: PlayerWallet
  payout: {
    id: string
    status?: string
  }
}

type ErrorResponse = {
  error?: string
}

type QrCodeImageProps = {
  value: string
  size?: number
  alt: string
}

type SpeedBridgeWindow = Window & typeof globalThis & {
  ReactNativeWebView?: {
    postMessage: (message: string) => void
  }
}

function formatSats(amount: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(amount))
}

function formatMultiplier(value: number): string {
  return `${value.toFixed(2)}x`
}

function formatChance(value: number | null): string {
  return value === null ? '--' : `${(value * 100).toFixed(2)}%`
}

function getOptionalString(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null
  }

  return value.trim()
}

function getOptionalObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function extractLightningInvoiceFromSpeedPayment(payment: SpeedPaymentObject | null | undefined): string | null {
  const paymentRecord = getOptionalObject(payment)
  const paymentMethodOptions = getOptionalObject(paymentRecord?.payment_method_options)
  const lightningOptions = getOptionalObject(paymentMethodOptions?.lightning)

  const candidates = [
    lightningOptions?.payment_request,
    paymentRecord?.lightning_invoice,
    paymentRecord?.payment_request,
  ]

  for (const candidate of candidates) {
    const value = getOptionalString(candidate)
    if (value && value.toLowerCase().startsWith('ln')) {
      return value
    }
  }

  return null
}

function extractHostedInvoiceUrlFromSpeedPayment(payment: SpeedPaymentObject | null | undefined): string | null {
  const paymentRecord = getOptionalObject(payment)
  return getOptionalString(paymentRecord?.hosted_invoice_url)
}

function normalizePaymentInfo(response: DepositResponse, amountSats: number): PaymentInfo {
  const fallbackInvoice =
    response.speedPrompt?.data.deposit_address ??
    extractLightningInvoiceFromSpeedPayment(response.speedPayment)

  const fallbackHostedInvoiceUrl = extractHostedInvoiceUrlFromSpeedPayment(response.speedPayment)
  const paymentInfo = response.paymentInfo

  return {
    invoiceId: paymentInfo?.invoiceId ?? response.speedPayment.id,
    amountSats: paymentInfo?.amountSats ?? response.speedPayment.amount ?? amountSats,
    lightningInvoice: paymentInfo?.lightningInvoice ?? fallbackInvoice ?? null,
    hostedInvoiceUrl: paymentInfo?.hostedInvoiceUrl ?? fallbackHostedInvoiceUrl ?? null,
    speedInterfaceUrl: paymentInfo?.speedInterfaceUrl ?? paymentInfo?.hostedInvoiceUrl ?? fallbackHostedInvoiceUrl ?? null,
    expiresAt: paymentInfo?.expiresAt ?? response.speedPayment.expires_at ?? null,
    purpose: paymentInfo?.purpose ?? 'topup',
  }
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

function QrCodeImage({ value, size = 220, alt }: QrCodeImageProps) {
  const [src, setSrc] = useState<string>('')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true

    if (!value) {
      setSrc('')
      setFailed(false)
      return () => {
        active = false
      }
    }

    setSrc('')
    setFailed(false)

    void QRCode.toDataURL(value, {
      width: size,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#111827',
        light: '#ffffff',
      },
    })
      .then((nextSrc: string) => {
        if (!active) {
          return
        }

        setSrc(nextSrc)
      })
      .catch(() => {
        if (!active) {
          return
        }

        setFailed(true)
      })

    return () => {
      active = false
    }
  }, [size, value])

  if (failed) {
    return <div className="small">Unable to render the QR image. Use the copy button below.</div>
  }

  if (!src) {
    return <div className="small">Generating QR…</div>
  }

  return <img src={src} width={size} height={size} alt={alt} className="qrImage" />
}

function getStoredLocalAccountId(): string {
  const existing = window.localStorage.getItem(LOCAL_DEV_ACCOUNT_STORAGE_KEY)
  if (existing) {
    return existing
  }

  const generated = `local-dev-${Math.random().toString(36).slice(2, 12)}`
  window.localStorage.setItem(LOCAL_DEV_ACCOUNT_STORAGE_KEY, generated)
  return generated
}

function getBootstrapParam(...keys: BootstrapParamKey[]): string | null {
  const hash = String(window.location.hash || '')
  const hashBody = hash.startsWith('#') ? hash.slice(1) : hash
  const sources = [new URLSearchParams(hashBody), new URLSearchParams(window.location.search || '')]

  for (const params of sources) {
    for (const key of keys) {
      const value = params.get(key)
      if (value !== null) {
        return value
      }
    }
  }

  return null
}

function parseBootstrapContext(): WalletBootstrapContext {
  const accountId = getOptionalString(getBootstrapParam('acct', 'accountId'))
  const lightningAddress =
    getOptionalString(readLightningAddressFromLocation()) ??
    getOptionalString(getBootstrapParam('p_add', 'lightningAddress'))

  return {
    accountId: accountId ?? getStoredLocalAccountId(),
    lightningAddress,
    language: getOptionalString(getBootstrapParam('lang')),
    balanceBtc: getOptionalNumber(getBootstrapParam('bal_btc')),
    balanceUsdt: getOptionalNumber(getBootstrapParam('bal_usdt')),
    source: accountId ? 'speed-wallet' : 'local-dev',
  }
}

function createFallbackWallet(context: WalletBootstrapContext): PlayerWallet {
  const now = new Date().toISOString()

  return {
    playerId: context.accountId,
    accountId: context.accountId,
    lightningAddress: context.lightningAddress,
    balance: 0,
    lastKnownSpeedBalanceSats: null,
    createdAt: now,
    updatedAt: now,
  }
}

function shortenMiddle(value: string | null | undefined, keep = 8): string {
  if (!value) {
    return '—'
  }

  if (value.length <= keep * 2 + 3) {
    return value
  }

  return `${value.slice(0, keep)}...${value.slice(-keep)}`
}

function formatHistoryTime(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}

function formatTransactionLabel(kind: string): string {
  return kind
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function getRandomHoleIndex(holeCount: number): number {
  return Math.floor(Math.random() * holeCount)
}

function isNumberTable(value: unknown): value is Record<number, number[]> {
  if (!value || typeof value !== 'object') {
    return false
  }

  return Object.values(value).every(
    (row) => Array.isArray(row) && row.every((entry) => typeof entry === 'number'),
  )
}

function getRoundHitChance(
  moleCount: number,
  round: number,
  roundChanceTable = ROUND_CHANCE_TABLE,
): number {
  const roundChances = roundChanceTable[moleCount]
  if (!roundChances) {
    throw new Error(`Unsupported mole count: ${moleCount}`)
  }

  const hitChance = roundChances[round - 1]
  if (typeof hitChance !== 'number') {
    throw new Error(`Unsupported round ${round} for mole count ${moleCount}`)
  }

  return hitChance
}

function getCumulativeMultiplier(
  moleCount: number,
  hitCount: number,
  multiplierTable = MULTIPLIER_TABLE,
): number {
  if (hitCount === 0) {
    return 0
  }

  const multiplier = multiplierTable[moleCount]?.[hitCount - 1]
  if (typeof multiplier !== 'number') {
    throw new Error(`Unsupported hit count ${hitCount} for mole count ${moleCount}`)
  }

  return multiplier
}

function getHoleState(game: ActiveGame | null, holeIndex: number): HoleVisualState {
  if (!game) {
    return 'hidden'
  }

  if (game.stage === 'awaiting-pick') {
    return game.selectedHole === holeIndex ? 'selected' : 'hidden'
  }

  if (game.stage === 'revealing-hit' || game.stage === 'won-all') {
    if (game.selectedHole === holeIndex) {
      return 'hit'
    }

    if (game.revealedHoles.includes(holeIndex)) {
      return 'mole-reveal'
    }

    return 'hidden'
  }

  if (game.stage === 'lost') {
    if (game.selectedHole === holeIndex) {
      return 'miss'
    }

    if (game.revealedHoles.includes(holeIndex)) {
      return 'mole-reveal'
    }
  }

  return 'hidden'
}

function mapBackendRoundToActiveGame(round: BackendRound): ActiveGame {
  return {
    id: round.id,
    betAmount: round.betAmount,
    moleCount: round.moleCount,
    round: round.currentRound,
    stage: round.stage,
    selectedHole: null,
    revealedHoles: [],
    hitCount: round.hitCount,
  }
}

function mapResolvedRoundToVisualGame(
  round: BackendRound,
  stage: Extract<RoundStage, 'revealing-hit' | 'lost' | 'won-all'>,
): ActiveGame {
  return {
    id: round.id,
    betAmount: round.betAmount,
    moleCount: round.moleCount,
    round: round.lastReveal?.round ?? round.currentRound,
    stage,
    selectedHole: round.lastReveal?.selectedHole ?? null,
    revealedHoles: round.lastReveal?.revealedHoles ?? [],
    hitCount: round.hitCount,
  }
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    cache: 'no-store',
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })

  const text = await response.text()
  const payload = text ? (JSON.parse(text) as T & ErrorResponse) : null

  if (!response.ok) {
    throw new Error(payload && typeof payload.error === 'string' ? payload.error : `Request failed (${response.status}).`)
  }

  return payload as T
}

function sendSpeedWalletPrompt(prompt: SpeedPromptPayload): boolean {
  const runtimeWindow = window as SpeedBridgeWindow
  const serialized = JSON.stringify(prompt)
  let dispatched = false

  if (runtimeWindow.ReactNativeWebView?.postMessage) {
    runtimeWindow.ReactNativeWebView.postMessage(serialized)
    dispatched = true
  }

  if (window.parent && window.parent !== window) {
    window.parent.postMessage(
      {
        type: 'speed-wallet-deposit-request',
        payload: prompt,
      },
      '*',
    )
    dispatched = true
  }

  window.postMessage(
    {
      type: 'speed-wallet-deposit-request',
      payload: prompt,
    },
    window.location.origin,
  )

  return dispatched
}

function MoleArtwork() {
  const gradientBaseId = useId().replace(/:/g, '')
  const bodyGradId = `${gradientBaseId}-body-grad`
  const bellyGradId = `${gradientBaseId}-belly-grad`
  const snoutGradId = `${gradientBaseId}-snout-grad`
  const noseGradId = `${gradientBaseId}-nose-grad`

  return (
    <svg className="mole-art" viewBox="0 0 128 170" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={bodyGradId} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#8c6651" />
          <stop offset="100%" stopColor="#6e4d3f" />
        </linearGradient>
        <linearGradient id={bellyGradId} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#d3b39a" />
          <stop offset="100%" stopColor="#bf9c82" />
        </linearGradient>
        <linearGradient id={snoutGradId} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#efe3d5" />
          <stop offset="100%" stopColor="#ddc7b2" />
        </linearGradient>
        <linearGradient id={noseGradId} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#ff9b36" />
          <stop offset="100%" stopColor="#f06b18" />
        </linearGradient>
      </defs>

      <ellipse cx="64" cy="88" rx="41" ry="58" fill="#17364b" opacity="0.18" />
      <ellipse cx="47" cy="30" rx="12" ry="12" fill="#765342" />
      <ellipse cx="81" cy="30" rx="12" ry="12" fill="#765342" />
      <ellipse cx="47" cy="31" rx="6" ry="6" fill="#d7b49b" />
      <ellipse cx="81" cy="31" rx="6" ry="6" fill="#d7b49b" />

      <rect x="24" y="24" width="80" height="120" rx="40" fill={`url(#${bodyGradId})`} />
      <ellipse cx="64" cy="35" rx="13" ry="6" fill="#fff8ee" opacity="0.72" />
      <ellipse cx="64" cy="118" rx="20" ry="11" fill={`url(#${bellyGradId})`} opacity="0.95" />

      <ellipse cx="64" cy="62" rx="25" ry="21" fill={`url(#${snoutGradId})`} />
      <ellipse cx="55.5" cy="54.5" rx="4.1" ry="4.8" fill="#1e2734" />
      <ellipse cx="72.5" cy="54.5" rx="4.1" ry="4.8" fill="#1e2734" />
      <circle cx="56.6" cy="53.3" r="1.1" fill="#ffffff" opacity="0.8" />
      <circle cx="73.6" cy="53.3" r="1.1" fill="#ffffff" opacity="0.8" />
      <ellipse cx="64" cy="64" rx="9.5" ry="7.4" fill={`url(#${noseGradId})`} />
      <path d="M64 70 C61 73, 58 74.5, 55 74.5" stroke="#1e2734" strokeWidth="2.8" strokeLinecap="round" fill="none" />
      <path d="M64 70 C67 73, 70 74.5, 73 74.5" stroke="#1e2734" strokeWidth="2.8" strokeLinecap="round" fill="none" />

      <circle cx="50" cy="63" r="1.3" fill="#8e6c56" />
      <circle cx="46" cy="67" r="1.3" fill="#8e6c56" />
      <circle cx="78" cy="63" r="1.3" fill="#8e6c56" />
      <circle cx="82" cy="67" r="1.3" fill="#8e6c56" />

      <ellipse cx="41" cy="92" rx="7" ry="11" fill="#7a5744" />
      <ellipse cx="87" cy="92" rx="7" ry="11" fill="#7a5744" />
      <ellipse cx="41" cy="96" rx="5.3" ry="7.5" fill="#d7b49b" />
      <ellipse cx="87" cy="96" rx="5.3" ry="7.5" fill="#d7b49b" />
    </svg>
  )
}

function App() {
  const bootstrapContext = useMemo(() => parseBootstrapContext(), [])
  const autoAdvanceTimeoutRef = useRef<number | null>(null)
  const hammerTimeoutRef = useRef<number | null>(null)
  const paymentWindowRef = useRef<Window | null>(null)
  const [controlMode, setControlMode] = useState<ControlMode>('manual')
  const [betAmount, setBetAmount] = useState(DEFAULT_BET)
  const [moleCount, setMoleCount] = useState(DEFAULT_MOLES)
  const [withdrawAmount, setWithdrawAmount] = useState('')
  const [lightningAddress, setLightningAddress] = useState(() => {
    const fromBootstrap = bootstrapContext.lightningAddress ?? ''
    const fromStorage = getStoredLightningAddress()
    const fromLocation = readLightningAddressFromLocation()
    return fromBootstrap || fromLocation || fromStorage || ''
  })
  const [lightningAddressLocked, setLightningAddressLocked] = useState(
    () =>
      bootstrapContext.source === 'speed-wallet' ||
      shouldForceLockLightningAddress() ||
      Boolean(readLightningAddressFromLocation() || bootstrapContext.lightningAddress),
  )
  const [wallet, setWallet] = useState<PlayerWallet | null>(() => createFallbackWallet(bootstrapContext))
  const [transactions, setTransactions] = useState<TransactionEntry[]>([])
  const [activeGame, setActiveGame] = useState<ActiveGame | null>(null)
  const [struckHole, setStruckHole] = useState<number | null>(null)
  const [multiplierTable, setMultiplierTable] = useState(MULTIPLIER_TABLE)
  const [roundChanceTable, setRoundChanceTable] = useState(ROUND_CHANCE_TABLE)
  const [maxRounds, setMaxRounds] = useState(MAX_ROUNDS)
  const [holeCount, setHoleCount] = useState(HOLE_COUNT)
  const [paymentInfo, setPaymentInfo] = useState<PaymentInfo | null>(null)
  const [showPaymentModal, setShowPaymentModal] = useState(false)
  const [paymentVerified, setPaymentVerified] = useState(false)
  const [verifyLoading, setVerifyLoading] = useState(false)
  const [payButtonLoading, setPayButtonLoading] = useState(false)
  const [flashMessage, setFlashMessage] = useState(
    'Connecting to the backend wallet ledger and loading your current balance.',
  )
  const [isRefreshingWallet, setIsRefreshingWallet] = useState(false)
  const [isDepositing, setIsDepositing] = useState(false)
  const [isWithdrawing, setIsWithdrawing] = useState(false)
  const [isStartingRound, setIsStartingRound] = useState(false)
  const [isRevealing, setIsRevealing] = useState(false)
  const [isCashingOut, setIsCashingOut] = useState(false)
  const [showHistoryModal, setShowHistoryModal] = useState(false)
  const [showAddCashModal, setShowAddCashModal] = useState(false)

  const currentRound = activeGame?.round ?? 1
  const currentHitCount = activeGame?.hitCount ?? 0
  const gameMoleCount = activeGame?.moleCount ?? moleCount
  const gameBetAmount = activeGame?.betAmount ?? betAmount
  const rawMultiplier = getCumulativeMultiplier(gameMoleCount, currentHitCount, multiplierTable)
  const currentMultiplier = activeGame?.stage === 'lost' ? 0 : rawMultiplier
  const currentPayout = activeGame?.stage === 'lost' ? 0 : Math.floor(gameBetAmount * currentMultiplier)
  const nextRoundChance =
    activeGame && (activeGame.stage === 'awaiting-pick' || activeGame.stage === 'revealing-hit')
      ? getRoundHitChance(activeGame.moleCount, activeGame.round, roundChanceTable)
      : null
  const isBusy = isDepositing || isWithdrawing || isStartingRound || isRevealing || isCashingOut
  const canPickHole = Boolean(activeGame && activeGame.stage === 'awaiting-pick' && !isBusy)
  const canAdjustControls = (!activeGame || activeGame.stage === 'setup') && !isBusy
  const showSetupActions = !activeGame || activeGame.stage === 'setup'
  const showCashoutAction = Boolean(
    activeGame &&
      (activeGame.stage === 'awaiting-pick' || activeGame.stage === 'revealing-hit') &&
      activeGame.hitCount > 0,
  )
  const showResetAction =
    activeGame?.stage === 'lost' ||
    activeGame?.stage === 'cashed-out' ||
    activeGame?.stage === 'won-all'
  const connectedLightningAddress =
    getOptionalString(lightningAddress) ?? wallet?.lightningAddress ?? bootstrapContext.lightningAddress
  const displayLightningAddress = formatDisplayLightningAddress(connectedLightningAddress ?? '')

  const paymentUrl = useMemo(() => {
    return paymentInfo?.speedInterfaceUrl || paymentInfo?.hostedInvoiceUrl || null
  }, [paymentInfo])

  function clearAutoAdvanceTimeout() {
    if (autoAdvanceTimeoutRef.current !== null) {
      window.clearTimeout(autoAdvanceTimeoutRef.current)
      autoAdvanceTimeoutRef.current = null
    }
  }

  function clearHammerTimeout() {
    if (hammerTimeoutRef.current !== null) {
      window.clearTimeout(hammerTimeoutRef.current)
      hammerTimeoutRef.current = null
    }
  }

  function applyWalletBalance(nextBalance: number) {
    setWallet((currentWallet) => {
      const baselineWallet = currentWallet ?? createFallbackWallet(bootstrapContext)

      return {
        ...baselineWallet,
        balance: nextBalance,
        lightningAddress: baselineWallet.lightningAddress ?? getOptionalString(lightningAddress),
        updatedAt: new Date().toISOString(),
      }
    })
  }

  async function copyTextToClipboard(value: string, successMessage: string) {
    try {
      await window.navigator.clipboard.writeText(value)
      setFlashMessage(successMessage)
    } catch {
      setFlashMessage('Unable to copy automatically. Please copy it manually.')
    }
  }

  const verifyPayment = useCallback(async () => {
    if (!paymentInfo?.invoiceId) {
      return
    }

    try {
      setVerifyLoading(true)
      const response = await fetchJson<VerifyPaymentResponse>(
        `/api/wallet/verify/${encodeURIComponent(paymentInfo.invoiceId)}?accountId=${encodeURIComponent(bootstrapContext.accountId)}`,
        {
          method: 'GET',
          headers: {},
        },
      )

      if (!response.paid) {
        return
      }

      setPaymentVerified(true)
      if (response.wallet) {
        setWallet(response.wallet)
      }

      await refreshWalletSummary({ silent: true })
      setFlashMessage('Payment verified. Your wallet balance has been updated.')
      setShowPaymentModal(false)
      setPayButtonLoading(false)
    } catch (error) {
      setFlashMessage(error instanceof Error ? error.message : 'Unable to verify payment.')
    } finally {
      setVerifyLoading(false)
    }
  }, [bootstrapContext.accountId, paymentInfo?.invoiceId])

  const onPay = useCallback(() => {
    if (!paymentUrl) {
      setFlashMessage('No payment URL available.')
      return
    }

    let navigated = false
    const popup = paymentWindowRef.current
    if (popup && !popup.closed) {
      try {
        popup.location.href = paymentUrl
        navigated = true
      } catch {
        // Fall through to alternate open strategies.
      }
    }

    if (!navigated) {
      navigated = openPaymentUrlSafely(paymentUrl)
    }

    if (navigated) {
      setPayButtonLoading(true)
    } else {
      setPayButtonLoading(false)
      setFlashMessage('Popup blocked. Use the Open Invoice link or scan the QR.')
    }
  }, [paymentUrl])

  async function refreshWalletSummary(options?: { silent?: boolean }) {
    const { silent = false } = options ?? {}

    if (!silent) {
      setIsRefreshingWallet(true)
    }

    try {
      const contextQuery = new URLSearchParams({
        acct: bootstrapContext.accountId,
      })

      if (connectedLightningAddress) {
        contextQuery.set('p_add', connectedLightningAddress)
      }

      if (bootstrapContext.language) {
        contextQuery.set('lang', bootstrapContext.language)
      }

      if (bootstrapContext.balanceBtc !== null) {
        contextQuery.set('bal_btc', String(bootstrapContext.balanceBtc))
      }

      if (bootstrapContext.balanceUsdt !== null) {
        contextQuery.set('bal_usdt', String(bootstrapContext.balanceUsdt))
      }

      const [contextResponse, historyResponse] = await Promise.all([
        fetchJson<WalletContextResponse>(`/api/wallet/context?${contextQuery.toString()}`, {
          method: 'GET',
          headers: {},
        }),
        fetchJson<HistoryResponse>(`/api/game/history?accountId=${encodeURIComponent(bootstrapContext.accountId)}`, {
          method: 'GET',
          headers: {},
        }),
      ])

      setWallet(contextResponse.wallet)
      setTransactions(historyResponse.transactions)
    } catch (error) {
      if (!silent) {
        setFlashMessage(error instanceof Error ? error.message : 'Unable to refresh wallet state.')
      }
    } finally {
      if (!silent) {
        setIsRefreshingWallet(false)
      }
    }
  }

  async function restoreActiveRound() {
    try {
      const response = await fetchJson<ActiveRoundResponse>(
        `/api/game/active-round?accountId=${encodeURIComponent(bootstrapContext.accountId)}`,
        {
          method: 'GET',
          headers: {},
        },
      )

      applyWalletBalance(response.walletBalance)

      if (response.round) {
        setActiveGame(mapBackendRoundToActiveGame(response.round))
        setFlashMessage(`Round ${response.round.currentRound} is still active on the backend. Pick a hole or cash out.`)
      }
    } catch {
      // Keep bootstrapping without blocking the UI.
    }
  }

  useEffect(
    () => () => {
      clearAutoAdvanceTimeout()
      clearHammerTimeout()
    },
    [],
  )

  useEffect(() => {
    return setupLightningAddressFetcher({
      onAddress: (address) => {
        setLightningAddress(address)
      },
      onLock: () => {
        setLightningAddressLocked(true)
      },
    })
  }, [])

  useEffect(() => {
    if (bootstrapContext.source === 'speed-wallet') {
      setLightningAddressLocked(true)
    }
  }, [bootstrapContext.source])

  useEffect(() => {
    if (!lightningAddress.trim()) {
      return
    }

    setStoredLightningAddress(lightningAddress)
  }, [lightningAddress])

  useEffect(() => {
    if (!getOptionalString(lightningAddress)) {
      return
    }

    void refreshWalletSummary({ silent: true })
  }, [lightningAddress])

  useEffect(() => {
    if (lightningAddress.trim()) {
      return
    }

    if (wallet?.lightningAddress) {
      setLightningAddress(wallet.lightningAddress)
    }
  }, [lightningAddress, wallet?.lightningAddress])

  useEffect(() => {
    if (!showPaymentModal || !paymentInfo?.invoiceId || paymentVerified) {
      return
    }

    let attempts = 0
    const maxAttempts = 50

    const intervalId = window.setInterval(() => {
      attempts += 1
      if (attempts > maxAttempts) {
        window.clearInterval(intervalId)
        return
      }

      void verifyPayment()
    }, 3000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [showPaymentModal, paymentInfo?.invoiceId, paymentVerified, verifyPayment])

  useEffect(() => {
    let ignore = false

    async function loadGameConfig() {
      try {
        const config = await fetchJson<GameConfigResponse>('/api/game/config', {
          method: 'GET',
          headers: {},
        })

        if (ignore) {
          return
        }

        if (typeof config.holeCount === 'number' && config.holeCount > 0) {
          setHoleCount(config.holeCount)
        }

        if (typeof config.maxRounds === 'number' && config.maxRounds > 0) {
          setMaxRounds(config.maxRounds)
        }

        if (isNumberTable(config.multiplierTable)) {
          setMultiplierTable(config.multiplierTable)
        }

        if (isNumberTable(config.roundChanceTable)) {
          setRoundChanceTable(config.roundChanceTable)
        }
      } catch {
        // Keep the local fallback values if the backend is unavailable during boot.
      }
    }

    void loadGameConfig()

    return () => {
      ignore = true
    }
  }, [])

  useEffect(() => {
    let stopped = false

    async function bootstrap() {
      await refreshWalletSummary()

      if (stopped) {
        return
      }

      await restoreActiveRound()

      if (stopped) {
        return
      }

      setFlashMessage(
        bootstrapContext.source === 'speed-wallet'
          ? 'Speed Wallet session connected. Deposits, gameplay, and withdrawals now run through the backend ledger.'
          : 'Standalone session loaded. Open this inside Speed Wallet to connect the embedded wallet flow.',
      )
    }

    void bootstrap()

    const pollIntervalId = window.setInterval(() => {
      void refreshWalletSummary({ silent: true })
    }, 5000)

    return () => {
      stopped = true
      window.clearInterval(pollIntervalId)
    }
  }, [bootstrapContext])

  async function startGame() {
    if (betAmount <= 0) {
      setFlashMessage('Enter a bet amount greater than 0.')
      return
    }

    if (moleCount < 1 || moleCount >= holeCount) {
      setFlashMessage(`Choose between 1 and ${holeCount - 1} moles.`)
      return
    }

    if ((wallet?.balance ?? 0) < betAmount) {
      setFlashMessage('Not enough balance. Deposit sats before placing a bet.')
      return
    }

    setIsStartingRound(true)
    clearAutoAdvanceTimeout()
    clearHammerTimeout()
    setStruckHole(null)

    try {
      const response = await fetchJson<RoundMutationResponse>('/api/game/rounds', {
        method: 'POST',
        body: JSON.stringify({
          accountId: bootstrapContext.accountId,
          betAmount,
          moleCount,
          lightningAddress: connectedLightningAddress,
        }),
      })

      applyWalletBalance(response.walletBalance)
      setActiveGame(mapBackendRoundToActiveGame(response.round))
      setFlashMessage('Bet placed on the backend. Pick a hole to reveal whether the mole is there.')
    } catch (error) {
      setFlashMessage(error instanceof Error ? error.message : 'Unable to start a round.')
    } finally {
      setIsStartingRound(false)
    }
  }

  async function pickHole(holeIndex: number) {
    if (!activeGame || activeGame.stage !== 'awaiting-pick') {
      return
    }

    setIsRevealing(true)
    clearHammerTimeout()
    clearAutoAdvanceTimeout()
    setStruckHole(holeIndex)
    hammerTimeoutRef.current = window.setTimeout(() => {
      setStruckHole(null)
      hammerTimeoutRef.current = null
    }, 520)

    try {
      const response = await fetchJson<RoundMutationResponse>('/api/game/reveal', {
        method: 'POST',
        body: JSON.stringify({
          roundId: activeGame.id,
          holeIndex,
        }),
      })

      applyWalletBalance(response.walletBalance)

      if (!response.hit) {
        setActiveGame(mapResolvedRoundToVisualGame(response.round, 'lost'))
        setFlashMessage('Missed. The mole popped out of a different hole and the backend locked the round as a loss.')
        return
      }

      if (response.round.stage === 'won-all') {
        setActiveGame(mapResolvedRoundToVisualGame(response.round, 'won-all'))
        setFlashMessage(`Perfect run. You cleared all ${maxRounds} rounds and the backend credited ${formatSats(response.round.payout)} sats.`)
        return
      }

      setActiveGame(mapResolvedRoundToVisualGame(response.round, 'revealing-hit'))
      setFlashMessage(`Hit confirmed on the backend. ${response.round.moleCount} moles revealed. Preparing round ${response.round.currentRound}.`)
      autoAdvanceTimeoutRef.current = window.setTimeout(() => {
        setActiveGame(mapBackendRoundToActiveGame(response.round))
        setFlashMessage(`Round ${response.round.currentRound} is live. Pick another hole or cash out any time.`)
        autoAdvanceTimeoutRef.current = null
      }, 850)
    } catch (error) {
      setFlashMessage(error instanceof Error ? error.message : 'Unable to reveal this hole.')
    } finally {
      setIsRevealing(false)
    }
  }

  async function cashOut() {
    if (
      !activeGame ||
      (activeGame.stage !== 'awaiting-pick' && activeGame.stage !== 'revealing-hit') ||
      activeGame.hitCount === 0
    ) {
      return
    }

    setIsCashingOut(true)
    clearAutoAdvanceTimeout()

    try {
      const response = await fetchJson<RoundMutationResponse>('/api/game/cashout', {
        method: 'POST',
        body: JSON.stringify({
          roundId: activeGame.id,
        }),
      })

      applyWalletBalance(response.walletBalance)
      setActiveGame({
        ...mapBackendRoundToActiveGame(response.round),
        stage: 'cashed-out',
      })
      setFlashMessage(`Cashed out ${formatSats(response.round.payout)} sats at ${formatMultiplier(response.round.multiplier)}.`)
    } catch (error) {
      setFlashMessage(error instanceof Error ? error.message : 'Unable to cash out this round.')
    } finally {
      setIsCashingOut(false)
    }
  }

  function resetGame() {
    clearAutoAdvanceTimeout()
    clearHammerTimeout()
    setStruckHole(null)
    setActiveGame(null)
    void refreshWalletSummary({ silent: true })
    setFlashMessage('Board reset. Adjust your bet settings and place another backend-backed round.')
  }

  async function requestDeposit(amount: number) {
    if (amount <= 0) {
      setFlashMessage('Deposit amount must be greater than 0.')
      return
    }

    setIsDepositing(true)
    setShowPaymentModal(false)
    setPaymentVerified(false)
    setPayButtonLoading(false)

    try {
      if (!paymentWindowRef.current || paymentWindowRef.current.closed) {
        paymentWindowRef.current = preopenPaymentWindow()
      }

      const response = await fetchJson<DepositResponse>('/api/wallet/deposit-request', {
        method: 'POST',
        body: JSON.stringify({
          accountId: bootstrapContext.accountId,
          amount,
          currency: 'SATS',
          targetCurrency: 'SATS',
          lightningAddress: connectedLightningAddress ?? undefined,
          note: 'Top up Moles game balance',
        }),
      })

      const dispatched = sendSpeedWalletPrompt(response.speedPrompt)
      setWallet(response.wallet)

      const nextPaymentInfo = normalizePaymentInfo(response, amount)

      setPaymentInfo(nextPaymentInfo)
      setShowPaymentModal(true)
      setShowAddCashModal(false)

      const paymentUrlToOpen = nextPaymentInfo.speedInterfaceUrl || nextPaymentInfo.hostedInvoiceUrl
      if (paymentUrlToOpen) {
        let navigated = false
        const popup = paymentWindowRef.current
        if (popup && !popup.closed) {
          try {
            popup.location.href = paymentUrlToOpen
            navigated = true
          } catch {
            // Fall through to alternate open strategies.
          }
        }

        if (!navigated) {
          navigated = openPaymentUrlSafely(paymentUrlToOpen)
        }

        if (navigated) {
          setPayButtonLoading(true)
        }
      }

      await refreshWalletSummary({ silent: true })
      setFlashMessage(
        dispatched
          ? `Pay ${formatSats(amount)} sats in Speed Wallet. Your balance will update after confirmation.`
          : `Deposit invoice created for ${formatSats(amount)} sats. Complete payment using the QR code or invoice link.`,
      )
    } catch (error) {
      setFlashMessage(error instanceof Error ? error.message : 'Unable to create a Speed Wallet deposit.')
    } finally {
      setIsDepositing(false)
    }
  }

  async function withdrawBalance() {
    const withdrawLightningAddress = connectedLightningAddress

    if (!withdrawLightningAddress) {
      setFlashMessage('Enter a Lightning address before withdrawing.')
      return
    }

    const parsedAmount = getOptionalNumber(withdrawAmount)
    if (withdrawAmount.trim().length > 0 && (!parsedAmount || parsedAmount <= 0)) {
      setFlashMessage('Withdrawal amount must be greater than 0.')
      return
    }

    setIsWithdrawing(true)

    try {
      const response = await fetchJson<WithdrawResponse>('/api/wallet/withdraw', {
        method: 'POST',
        body: JSON.stringify({
          accountId: bootstrapContext.accountId,
          amount: parsedAmount ?? undefined,
          lightningAddress: withdrawLightningAddress,
          note: 'Moles withdrawal',
        }),
      })

      setWallet(response.wallet)
      setLightningAddress(response.wallet.lightningAddress ?? withdrawLightningAddress)
      setWithdrawAmount('')
      await refreshWalletSummary({ silent: true })
      setFlashMessage(
        response.payout.status
          ? `Withdrawal created with Speed status: ${response.payout.status}.`
          : 'Withdrawal request created and sent to Speed.',
      )
    } catch (error) {
      setFlashMessage(error instanceof Error ? error.message : 'Unable to create a withdrawal.')
    } finally {
      setIsWithdrawing(false)
    }
  }

  function randomPick() {
    if (!canPickHole) {
      return
    }

    pickHole(getRandomHoleIndex(holeCount))
  }

  function renderHole(holeIndex: number) {
    const state = getHoleState(activeGame, holeIndex)
    const showMole = state === 'hit' || state === 'mole-reveal'
    const showMiss = state === 'miss'
    const isStruck = struckHole === holeIndex
    const stateClass =
      state === 'selected'
        ? 'holeSelected'
        : state === 'hit'
          ? 'holeHit'
          : state === 'mole-reveal'
            ? 'holeMoleReveal'
            : ''

    return (
      <button
        key={holeIndex}
        type="button"
        className={`hole ${stateClass} ${isStruck ? 'holeStruck' : ''}`}
        onClick={() => pickHole(holeIndex)}
        disabled={!canPickHole}
      >
        <span className="holeShadow" />
        <span className="holeRingOuter holeRing" />
        <span className="holeRingMiddle holeRing" />
        <span className="holeRingInner holeRing" />
        <span className="holeWell" />
        <span className="holeDust holeDustLeft" />
        <span className="holeDust holeDustRight" />
        <span className="holeDust holeDustCenter" />
        <span className="hammerSwing" aria-hidden="true">
          <span className="hammerHandle" />
          <span className="hammerHead" />
        </span>
        <span className={`holeCharacter ${showMiss ? 'holeCharacterMiss' : ''}`}>
          {showMole && (
            <span className="moleViewport">
              <span className="moleRiseShadow" />
              <span className="moleMotion">
                <MoleArtwork />
              </span>
              <span className="moleFrontMask" aria-hidden="true" />
            </span>
          )}
          {showMiss && <span className="missMark">X</span>}
        </span>
      </button>
    )
  }

  const primaryActionLabel = showSetupActions
    ? isStartingRound
      ? 'Placing Bet…'
      : 'Place Bet'
    : showCashoutAction
      ? isCashingOut
        ? 'Cashing Out…'
        : `Cash Out · ${formatSats(currentPayout)} sats`
      : showResetAction
        ? 'New Bet'
        : canPickHole
          ? isRevealing
            ? 'Revealing…'
            : 'Pick a Hole'
          : 'Waiting…'

  const handlePrimaryAction = () => {
    if (showSetupActions) {
      void startGame()
      return
    }

    if (showCashoutAction) {
      void cashOut()
      return
    }

    if (showResetAction) {
      resetGame()
      return
    }

    if (canPickHole) {
      randomPick()
    }
  }

  const primaryDisabled =
    showSetupActions
      ? isStartingRound
      : showCashoutAction
        ? isCashingOut
        : showResetAction
          ? false
          : !canPickHole || isRevealing

  return (
    <div className="shell">
      <header className="topbar">
        <div className="logoWrap">
          <div className="logo">BTC Moles</div>
          <div className="logoSub">
            {lightningAddressLocked
              ? displayLightningAddress.trim() || 'Fetching Speed lightning address...'
              : displayLightningAddress.trim() || 'Set lightning address in Add Cash'}
          </div>
        </div>
        <div className={`conn ${bootstrapContext.source === 'speed-wallet' ? 'ok' : 'neutral'}`}>
          {bootstrapContext.source === 'speed-wallet'
            ? `Connected (${shortenMiddle(bootstrapContext.accountId, 3)})`
            : 'Standalone'}
        </div>
      </header>

      <div className="layout">
        <aside className="panel">
          <div className="panelHeaderRow">
            <div className="panelTitle">Controls</div>
            <div className="modeTabs" role="tablist" aria-label="Play mode">
              <button
                type="button"
                role="tab"
                aria-selected={controlMode === 'manual'}
                className={`modeTab ${controlMode === 'manual' ? 'modeTabActive' : ''}`}
                onClick={() => setControlMode('manual')}
              >
                Manual
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={controlMode === 'auto'}
                className={`modeTab ${controlMode === 'auto' ? 'modeTabActive' : ''}`}
                onClick={() => setControlMode('auto')}
              >
                Auto
              </button>
            </div>
          </div>

          <div className="field">
            <div className="fieldLabel">Wallet Balance</div>
            <div className="walletBalance">{formatSats(wallet?.balance ?? 0)} SATS</div>
            <div className="walletActions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setShowAddCashModal(true)}
                disabled={isDepositing}
              >
                Add Cash
              </button>
              <button type="button" className="button secondary" onClick={() => setShowHistoryModal(true)}>
                History
              </button>
            </div>
          </div>

          <div className="field">
            <div className="fieldLabel">Bet Amount (SATS)</div>
            <div className="betGrid">
              {BET_PRESETS.map((amount) => (
                <button
                  key={amount}
                  type="button"
                  className={`betPill ${amount === betAmount ? 'active' : ''}`}
                  onClick={() => setBetAmount(amount)}
                  disabled={!canAdjustControls}
                  aria-pressed={amount === betAmount}
                >
                  {amount}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <div className="fieldLabel">Moles</div>
            <div className="moleGrid">
              {MOLE_OPTIONS.map((count) => (
                <button
                  key={count}
                  type="button"
                  className={`betPill ${count === moleCount ? 'active' : ''}`}
                  onClick={() => setMoleCount(count)}
                  disabled={!canAdjustControls}
                  aria-pressed={count === moleCount}
                >
                  {count}
                </button>
              ))}
            </div>
          </div>

          {activeGame && activeGame.stage !== 'setup' ? (
            <div className="gameStats">
              <div className="gameStat">
                <span className="gameStatLabel">Round</span>
                <strong>{`${currentRound}/${maxRounds}`}</strong>
              </div>
              <div className="gameStat">
                <span className="gameStatLabel">Win chance</span>
                <strong>{formatChance(nextRoundChance)}</strong>
              </div>
              <div className="gameStat">
                <span className="gameStatLabel">Multiplier</span>
                <strong>{currentMultiplier > 0 ? formatMultiplier(currentMultiplier) : '—'}</strong>
              </div>
              <div className="gameStat">
                <span className="gameStatLabel">Payout</span>
                <strong>{currentPayout > 0 ? `${formatSats(currentPayout)} sats` : '—'}</strong>
              </div>
            </div>
          ) : null}

          <button
            type="button"
            className={`primary ${showCashoutAction ? 'primaryCashout' : ''}`}
            onClick={handlePrimaryAction}
            disabled={primaryDisabled}
          >
            {primaryActionLabel}
          </button>

          {flashMessage ? <div className="panelNote">{flashMessage}</div> : <div className="panelNote muted">Ready.</div>}
        </aside>

        <section className="stage">
          <div className="stageCard">
            <div className="stageTop">
              <div className="stageTitle">Moles</div>
              <div className="stageSub">
                Top up once, then place your bet from your wallet. Pick a hole, cash out before you miss, and winnings are added to your wallet balance.
              </div>
            </div>

            <div className="boardFrame">
              <span className="boardLight boardLightLeft" />
              <span className="boardLight boardLightRight" />
              <span className="boardGrain" />
              <div className="holesStage">
                <div className="holesRow holesRowTop">{TOP_ROW_HOLES.map(renderHole)}</div>
                <div className="holesRow holesRowMiddle">{MIDDLE_ROW_HOLES.map(renderHole)}</div>
                <div className="holesRow holesRowBottom">{BOTTOM_ROW_HOLES.map(renderHole)}</div>
              </div>
            </div>
          </div>
        </section>
      </div>

      {showHistoryModal ? (
        <div className="modalOverlay" role="dialog" aria-modal="true">
          <div className="modal">
            <div className="modalHeader">
              <div className="modalTitle">History</div>
              <button type="button" className="button secondary" onClick={() => setShowHistoryModal(false)}>
                Close
              </button>
            </div>

            <div className="muted">Deposits, bets, and withdrawals for this wallet.</div>

            <div style={{ marginTop: 12, maxHeight: 420, overflow: 'auto' }}>
              {transactions.length > 0 ? (
                transactions.map((entry) => (
                  <div key={entry.id} className="historyItem">
                    <div>
                      <strong>{formatTransactionLabel(entry.kind)}</strong>
                      <span className="muted">{formatHistoryTime(entry.createdAt)}</span>
                    </div>
                    <div className={`historyAmount history-${entry.status}`}>
                      {entry.direction === 'debit' || entry.kind === 'withdrawal' || entry.kind === 'bet_placed' ? '-' : '+'}
                      {formatSats(entry.amount)}
                    </div>
                  </div>
                ))
              ) : (
                <div className="muted" style={{ marginTop: 12 }}>
                  No transactions yet.
                </div>
              )}
            </div>

            <div className="actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => void refreshWalletSummary()}
                disabled={isRefreshingWallet}
              >
                {isRefreshingWallet ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showPaymentModal && paymentInfo ? (
        <div className="modalOverlay" role="dialog" aria-modal="true">
          <div className="modal">
            <div className="modalHeader">
              <div className="modalTitle">Add {formatSats(paymentInfo.amountSats)} SATS to wallet</div>
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  setShowPaymentModal(false)
                  setPayButtonLoading(false)
                }}
              >
                Close
              </button>
            </div>

            <div className="muted">
              Complete payment in Speed. After confirmation, your wallet balance will be updated.
            </div>

            {paymentUrl ? (
              <div className="actions">
                <button type="button" className="button" onClick={onPay} disabled={payButtonLoading}>
                  {payButtonLoading ? 'Opening…' : 'Pay'}
                </button>
                <a className="button secondary" href={paymentUrl} target="_blank" rel="noopener noreferrer">
                  Open Invoice
                </a>
                <button type="button" className="button secondary" onClick={() => void verifyPayment()} disabled={verifyLoading}>
                  {verifyLoading ? 'Checking…' : "I've paid"}
                </button>
              </div>
            ) : null}

            {paymentUrl || paymentInfo.lightningInvoice ? (
              <div className="qrGrid">
                {paymentUrl ? (
                  <div className="qrCard">
                    <div className="qrTitle">Scan in Speed</div>
                    <div className="muted paymentHint">On desktop, scan this QR with your phone to open the Speed payment page.</div>
                    <div className="qrWrap">
                      <QrCodeImage value={paymentUrl} size={220} alt="Speed payment QR code" />
                    </div>
                    <div className="copyRow">
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => void copyTextToClipboard(paymentUrl, 'Payment link copied to your clipboard.')}
                      >
                        Copy payment link
                      </button>
                    </div>
                  </div>
                ) : null}

                {paymentInfo.lightningInvoice ? (
                  <div className="qrCard">
                    <div className="qrTitle">Lightning Invoice (BOLT11)</div>
                    <div className="muted paymentHint">If your wallet supports Lightning invoice scanning, you can scan this directly.</div>
                    <div className="qrWrap">
                      <QrCodeImage value={paymentInfo.lightningInvoice} size={220} alt="Lightning invoice QR code" />
                    </div>
                    <div className="copyRow">
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() =>
                          void copyTextToClipboard(paymentInfo.lightningInvoice ?? '', 'Payment address copied to your clipboard.')
                        }
                      >
                        Copy payment address
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="qrCard">
                    <div className="qrTitle">Lightning Invoice</div>
                    <div className="muted paymentHint">Not available here. Use the Pay button.</div>
                  </div>
                )}
              </div>
            ) : null}

            <div className="paymentStatus">
              {paymentVerified
                ? 'Payment verified. Waiting for wallet update…'
                : 'Waiting for payment confirmation…'}
            </div>

            <div className="small">Invoice ID: {paymentInfo.invoiceId}</div>
            <div className="copyRow">
              <button
                type="button"
                className="button secondary"
                onClick={() => void copyTextToClipboard(paymentInfo.invoiceId, 'Invoice ID copied to your clipboard.')}
              >
                Copy invoice ID
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showAddCashModal ? (
        <div className="modalOverlay" role="dialog" aria-modal="true">
          <div className="modal">
            <div className="modalHeader">
              <div className="modalTitle">Add Cash</div>
              <button type="button" className="button secondary" onClick={() => setShowAddCashModal(false)}>
                Close
              </button>
            </div>

            <div className="muted">Choose an amount to deposit. Your wallet balance will update after payment confirmation.</div>

            <div className="topUpGrid">
              {TOP_UP_OPTIONS.map((amount) => (
                <button
                  key={amount}
                  type="button"
                  className="button"
                  onClick={() => {
                    setShowAddCashModal(false)
                    void requestDeposit(amount)
                  }}
                  disabled={isDepositing}
                >
                  Add {formatSats(amount)}
                </button>
              ))}
            </div>

            <div className="actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => void withdrawBalance()}
                disabled={isWithdrawing || (wallet?.balance ?? 0) <= 0}
              >
                {isWithdrawing ? 'Sending sats…' : 'Withdraw'}
              </button>
            </div>

            <div className="field">
              <div className="fieldLabel">Lightning Address</div>
              <input
                className="input"
                type="text"
                value={lightningAddress}
                onChange={(event) => setLightningAddress(event.target.value)}
                placeholder="example@speed.app"
                disabled={isWithdrawing}
              />
              {displayLightningAddress.trim() ? (
                <div className="muted">Detected: {displayLightningAddress}</div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default App
