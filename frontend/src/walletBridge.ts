export const MOLES_LIGHTNING_ADDRESS_STORAGE_KEY = 'molesLightningAddress'
export const MOLES_LN_ADDRESS_REQUEST_TYPE = 'moles_request_ln_address'
export const BTC_SLIDES_LN_ADDRESS_REQUEST_TYPE = 'btc_slides_request_ln_address'

export function normalizeLightningAddress(input: string): string {
  return String(input || '').trim().toLowerCase()
}

export function getStoredLightningAddress(): string {
  try {
    return normalizeLightningAddress(window.localStorage.getItem(MOLES_LIGHTNING_ADDRESS_STORAGE_KEY) || '')
  } catch {
    return ''
  }
}

export function setStoredLightningAddress(address: string): void {
  try {
    const normalized = normalizeLightningAddress(address)
    if (normalized) {
      window.localStorage.setItem(MOLES_LIGHTNING_ADDRESS_STORAGE_KEY, normalized)
    }
  } catch {
    // Ignore storage restrictions.
  }
}

export function isTrustedSpeedOrigin(origin: string): boolean {
  const value = String(origin || '').toLowerCase()
  return !value || value.includes('tryspeed.com') || value.includes('speed')
}

export function shouldForceLockLightningAddress(): boolean {
  return String(import.meta.env.VITE_LOCK_LN_ADDRESS || '') === '1'
}

export function formatDisplayLightningAddress(input: string): string {
  const value = normalizeLightningAddress(input)
  if (!value) {
    return ''
  }

  if (value.includes('@')) {
    return value
  }

  return `${value}@speed.app`
}

function readLightningAddressFromSearchParams(params: URLSearchParams): string {
  const pAddRaw = normalizeLightningAddress(params.get('p_add') ?? '')
  if (pAddRaw) {
    return pAddRaw.includes('@') ? pAddRaw.split('@')[0] : pAddRaw
  }

  const keys = [
    'lightningAddress',
    'lightning_address',
    'lnAddress',
    'ln_address',
    'speedLightningAddress',
    'speed_lightning_address',
    'address',
  ]

  for (const key of keys) {
    const value = normalizeLightningAddress(params.get(key) ?? '')
    if (value) {
      return value
    }
  }

  return ''
}

export function readLightningAddressFromLocation(): string {
  try {
    const hash = String(window.location.hash || '')
    const hashBody = hash.startsWith('#') ? hash.slice(1) : hash
    const hashParams = new URLSearchParams(hashBody)
    const fromHash = readLightningAddressFromSearchParams(hashParams)
    if (fromHash) {
      return fromHash
    }

    const search = new URLSearchParams(window.location.search || '')
    return readLightningAddressFromSearchParams(search)
  } catch {
    return ''
  }
}

export function openPaymentUrlSafely(url: string): boolean {
  if (!url) {
    return false
  }

  try {
    const preWin = window.open('about:blank', '_blank')
    if (preWin && typeof preWin.location !== 'undefined') {
      try {
        preWin.opener = null
      } catch {
        // Ignore cross-origin restrictions.
      }
      preWin.location.href = url
      return true
    }
  } catch {
    // Fall through to alternate open strategies.
  }

  try {
    const popup = window.open(url, '_blank', 'noopener,noreferrer')
    if (popup) {
      return true
    }
  } catch {
    // Fall through.
  }

  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.target = '_blank'
    anchor.rel = 'noopener noreferrer'
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    return true
  } catch {
    // Fall through.
  }

  try {
    window.location.href = url
    return true
  } catch {
    return false
  }
}

export function preopenPaymentWindow(): Window | null {
  try {
    const popup = window.open('about:blank', '_blank')
    if (popup) {
      try {
        popup.opener = null
      } catch {
        // Ignore cross-origin restrictions.
      }
    }
    return popup
  } catch {
    return null
  }
}

export type ParentLightningAddressMessage = {
  payload?: ParentLightningAddressMessage | string | null
  lightningAddress?: string
  lightning_address?: string
  lnAddress?: string
  ln_address?: string
  speedLightningAddress?: string
  speed_lightning_address?: string
  address?: string
}

function toParentLightningMessage(data: unknown): ParentLightningAddressMessage | null {
  if (!data) {
    return null
  }

  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data) as unknown
      return toParentLightningMessage(parsed)
    } catch {
      return null
    }
  }

  if (typeof data !== 'object') {
    return null
  }

  return data as ParentLightningAddressMessage
}

function readCandidateLightningAddress(payload: ParentLightningAddressMessage): string | null {
  const maybe =
    payload.lightningAddress ??
    payload.lightning_address ??
    payload.lnAddress ??
    payload.ln_address ??
    payload.speedLightningAddress ??
    payload.speed_lightning_address ??
    payload.address ??
    null

  return typeof maybe === 'string' ? maybe : null
}

export function extractLightningAddressFromMessage(data: unknown): string | null {
  const payload = toParentLightningMessage(data)
  if (!payload) {
    return null
  }

  const maybe = readCandidateLightningAddress(payload) ?? readCandidateLightningAddress(toParentLightningMessage(payload.payload) ?? {})
  const address = normalizeLightningAddress(String(maybe || ''))
  if (!address || !address.includes('@')) {
    return null
  }

  return address
}

export type LightningAddressFetcherCallbacks = {
  onAddress: (address: string) => void
  onLock: () => void
}

export function setupLightningAddressFetcher(callbacks: LightningAddressFetcherCallbacks): () => void {
  const detected = readLightningAddressFromLocation()

  if (detected) {
    callbacks.onAddress(detected)
    callbacks.onLock()
  } else if (shouldForceLockLightningAddress()) {
    callbacks.onLock()
  }

  const onMessage = (event: MessageEvent) => {
    if (!isTrustedSpeedOrigin(event.origin)) {
      return
    }

    const address = extractLightningAddressFromMessage(event.data)
    if (!address) {
      return
    }

    callbacks.onAddress(address)
    callbacks.onLock()
  }

  window.addEventListener('message', onMessage)

  if (!detected) {
    try {
      window.parent?.postMessage({ type: MOLES_LN_ADDRESS_REQUEST_TYPE }, '*')
      window.parent?.postMessage({ type: BTC_SLIDES_LN_ADDRESS_REQUEST_TYPE }, '*')
    } catch {
      // Ignore cross-origin restrictions.
    }
  }

  return () => {
    window.removeEventListener('message', onMessage)
  }
}
