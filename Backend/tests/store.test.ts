import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import type { GameRound } from '../src/types'

const testDirectory = mkdtempSync(join(tmpdir(), 'moles-ledger-test-'))
process.env.LEDGER_DB_PATH = join(testDirectory, 'ledger.db')
process.env.LEDGER_FILE_PATH = join(testDirectory, 'missing-ledger.json')

let store: typeof import('../src/store')

before(async () => {
  store = await import('../src/store')
})

after(() => {
  store.closeStore()
  rmSync(testDirectory, { recursive: true, force: true })
})

function makeRound(accountId: string, id: string): GameRound {
  const now = new Date().toISOString()
  return {
    id,
    playerId: accountId,
    accountId,
    betAmount: 20,
    moleCount: 6,
    stage: 'awaiting-pick',
    currentRound: 1,
    hitCount: 0,
    payout: 0,
    multiplier: 0,
    revealedHistory: [],
    payoutSent: false,
    createdAt: now,
    updatedAt: now,
  }
}

test('bet placement prevents a second active round and preserves first-bet state', () => {
  const accountId = 'round-test-account'
  store.updateWalletBalance(accountId, 100)

  const first = store.placeBet(makeRound(accountId, 'round-one'))
  assert.equal(first.ok, true)
  if (!first.ok) return
  assert.equal(first.round.firstBet, true)
  assert.equal(first.wallet.balance, 80)

  const rejected = store.placeBet(makeRound(accountId, 'round-two'))
  assert.equal(rejected.ok, false)
  if (rejected.ok) return
  assert.equal(rejected.reason, 'active-round')
  assert.equal(rejected.wallet.balance, 80)

  const completedRound = store.getRound('round-one')
  assert.ok(completedRound)
  completedRound.stage = 'lost'
  store.saveRound(completedRound)

  const later = store.placeBet(makeRound(accountId, 'round-three'))
  assert.equal(later.ok, true)
  if (!later.ok) return
  assert.equal(later.round.firstBet, false)
  assert.equal(later.wallet.balance, 60)
})

test('failed withdrawal returns the reserved amount to the current balance atomically', () => {
  const accountId = 'withdraw-test-account'
  store.updateWalletBalance(accountId, 100)
  store.updateWalletBalance(accountId, 80)
  store.setWalletHold(accountId, 20)
  store.setPendingWithdrawal(accountId, {
    withdrawalId: 'withdrawal-one',
    amountSats: 20,
    requestedAt: new Date().toISOString(),
    reason: 'manual_withdraw',
  })
  const transaction = store.appendTransaction({
    playerId: accountId,
    accountId,
    roundId: null,
    externalId: null,
    kind: 'withdrawal',
    direction: 'debit',
    status: 'pending',
    amount: 20,
    currency: 'SATS',
    provider: 'speed',
    note: 'Speed Wallet withdrawal requested',
    metadata: {},
  })

  store.updateWalletBalance(accountId, 65)
  const wallet = store.rollbackFailedWithdrawal(accountId, 20, transaction.id)

  assert.equal(wallet.balance, 85)
  assert.equal(wallet.holdSats, 0)
  assert.equal(wallet.pendingWithdrawal, null)
  assert.equal(store.listTransactions(accountId)[0]?.status, 'failed')
})