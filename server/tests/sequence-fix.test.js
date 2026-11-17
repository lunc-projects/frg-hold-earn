// Sequence-fix tests (2026-11-17): the daily run paid 15 of 18
// wallets; 3 sends failed with "account sequence mismatch,
// expected 95, got 94" because each send signed with a sequence
// read from a node that had not yet seen the previous send land.
// These tests pin the fixed behavior:
// - fresh LCD sequence before EVERY attempt, never batch-captured
// - a mismatch retries THAT payment with a fresh read (max 3)
// - sends from the one payout account are serialized
// - an ambiguous broadcast is checked BY HASH before any resend
//   (a landed tx is reported paid, never paid twice)
// - the row is marked paid exactly once, with the landed hash
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SigningCosmWasmClient } from '@cosmjs/cosmwasm-stargate';
import {
  createPayout, fetchAccountSequence, pollTxOutcome,
  isSequenceMismatchError, isBroadcastRejection, sendWithSequenceRetry,
} from '../src/payout.js';
import { openStore } from '../src/store.js';
import { runPayoutDay } from '../src/server.js';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TERRA_ADDR = 'terra1amdttz2937a3dytmxmkany53pp6ma6dy4vsllv'; // test mnemonic's Terra (330) address
const RECIPIENT = 'terra1' + 'r'.repeat(38);
const noSleep = async () => {};
const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex').toUpperCase();

// The exact rejection the chain produced on 2026-11-17.
function mismatchError(expected, got) {
  return Object.assign(
    new Error(`Broadcasting transaction failed with code 32 (codespace: sdk). Log: account sequence mismatch, expected ${expected}, got ${got}: incorrect account sequence`),
    { code: 32, codespace: 'sdk' });
}

// ── error classifiers ────────────────────────────────────────

test('classifier: the 2026-11-17 mismatch is recognized in all its shapes', () => {
  assert.equal(isSequenceMismatchError(mismatchError(95, 94)), true);
  assert.equal(isSequenceMismatchError(new Error('account sequence mismatch, expected 95, got 94')), true);
  assert.equal(isSequenceMismatchError(new Error('Transaction failed with code 32: incorrect account sequence')), true);
  assert.equal(isSequenceMismatchError(Object.assign(new Error('boom'), { code: 32, codespace: 'sdk' })), true);
});

test('classifier: other failures are NOT mismatches and never retry', () => {
  const fees = Object.assign(new Error('Broadcasting transaction failed with code 13 (codespace: sdk). Log: insufficient fees'), { code: 13, codespace: 'sdk' });
  assert.equal(isSequenceMismatchError(fees), false);
  assert.equal(isSequenceMismatchError(new Error('rewards pool empty, top up')), false);
  assert.equal(isSequenceMismatchError(null), false);
  assert.equal(isBroadcastRejection(fees), true);
  assert.equal(isBroadcastRejection(new TypeError('fetch failed')), false);
});

// ── LCD helpers ──────────────────────────────────────────────

function withFetch(handler, fn) {
  const realFetch = global.fetch;
  global.fetch = handler;
  return fn().finally(() => { global.fetch = realFetch; });
}

test('fetchAccountSequence parses a BaseAccount (string numbers -> numbers)', async () => {
  await withFetch(async (url) => {
    assert.match(String(url), /\/cosmos\/auth\/v1beta1\/accounts\/terra1/);
    return { ok: true, json: async () => ({ account: { '@type': '/cosmos.auth.v1beta1.BaseAccount', account_number: '777', sequence: '94' } }) };
  }, async () => {
    assert.deepEqual(await fetchAccountSequence('http://lcd', TERRA_ADDR), { accountNumber: 777, sequence: 94 });
  });
});

test('fetchAccountSequence unwraps vesting-style accounts via base_account', async () => {
  await withFetch(async () => ({
    ok: true,
    json: async () => ({ account: { '@type': '/cosmos.vesting.v1beta1.PeriodicVestingAccount', base_account: { account_number: '5', sequence: '9' } } }),
  }), async () => {
    assert.deepEqual(await fetchAccountSequence('http://lcd', TERRA_ADDR), { accountNumber: 5, sequence: 9 });
  });
});

test('fetchAccountSequence throws on an LCD error (row fails, stays owed — as before)', async () => {
  await withFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }), async () => {
    await assert.rejects(() => fetchAccountSequence('http://lcd', TERRA_ADDR), /LCD account query failed \(500\)/);
  });
});

test('pollTxOutcome: not-yet-indexed, then success', async () => {
  const responses = [
    { ok: false, status: 404, json: async () => ({}) },
    { ok: true, json: async () => ({ tx_response: { code: 0, txhash: 'ABC' } }) },
  ];
  await withFetch(async () => responses.shift(), async () => {
    const out = await pollTxOutcome('http://lcd', 'ABC', { attempts: 5, intervalMs: 0, sleep: noSleep });
    assert.equal(out.status, 'success');
  });
});

test('pollTxOutcome: code 32 is sequence-failed, other codes are failed with the log', async () => {
  await withFetch(async () => ({ ok: true, json: async () => ({ tx_response: { code: 32, raw_log: 'account sequence mismatch' } }) }), async () => {
    assert.equal((await pollTxOutcome('http://lcd', 'H', { attempts: 1, sleep: noSleep })).status, 'sequence-failed');
  });
  await withFetch(async () => ({ ok: true, json: async () => ({ tx_response: { code: 5, raw_log: 'out of gas' } }) }), async () => {
    const out = await pollTxOutcome('http://lcd', 'H', { attempts: 1, sleep: noSleep });
    assert.equal(out.status, 'failed');
    assert.equal(out.error, 'out of gas');
  });
});

test('pollTxOutcome: never sighted within the window is not-found', async () => {
  await withFetch(async () => ({ ok: false, status: 404, json: async () => ({}) }), async () => {
    assert.equal((await pollTxOutcome('http://lcd', 'H', { attempts: 3, intervalMs: 0, sleep: noSleep })).status, 'not-found');
  });
});

// ── the retry engine ─────────────────────────────────────────

test('engine: mismatch mid-batch retries with a FRESH sequence and pays exactly once', async () => {
  const reads = [{ accountNumber: 7, sequence: 94 }, { accountNumber: 7, sequence: 95 }];
  const signedWith = [];
  let fetchCalls = 0;
  const hash = await sendWithSequenceRetry({
    fetchSequence: async () => { fetchCalls++; return reads.shift(); },
    attempt: async ({ sequence }) => {
      signedWith.push(sequence);
      if (sequence === 94) throw mismatchError(95, 94); // the 2026-11-17 rejection
      return { status: 'confirmed', txHash: 'HASH95' };
    },
    checkTxByHash: async () => { throw new Error('must not be consulted for a definite rejection'); },
    sleep: noSleep, retryDelayMs: 0,
  });
  assert.equal(hash, 'HASH95');
  assert.deepEqual(signedWith, [94, 95]); // second attempt signed the FRESH sequence
  assert.equal(fetchCalls, 2);            // one fresh read per attempt, never reused
});

test('engine: an ambiguous broadcast that LANDED is returned, never resent (no double-pay)', async () => {
  let attempts = 0;
  const hash = await sendWithSequenceRetry({
    fetchSequence: async () => ({ accountNumber: 7, sequence: 95 }),
    attempt: async () => { attempts++; return { status: 'ambiguous', txHash: 'LANDED1' }; },
    checkTxByHash: async (h) => { assert.equal(h, 'LANDED1'); return { status: 'success' }; },
    sleep: noSleep, retryDelayMs: 0,
  });
  assert.equal(hash, 'LANDED1');
  assert.equal(attempts, 1); // signed ONCE — the landed tx is the payment
});

test('engine: ambiguous and never landed -> resend with a fresh sequence', async () => {
  const signedWith = [];
  const seqs = [{ accountNumber: 7, sequence: 95 }, { accountNumber: 7, sequence: 95 }];
  const hash = await sendWithSequenceRetry({
    fetchSequence: async () => seqs.shift(),
    attempt: async ({ sequence }) => {
      signedWith.push(sequence);
      return signedWith.length === 1
        ? { status: 'ambiguous', txHash: 'LOST1' }
        : { status: 'confirmed', txHash: 'SENT2' };
    },
    checkTxByHash: async () => ({ status: 'not-found' }),
    sleep: noSleep, retryDelayMs: 0,
  });
  assert.equal(hash, 'SENT2');
  assert.equal(signedWith.length, 2);
});

test('engine: ambiguous tx that landed but FAILED on-chain fails the row (no resend)', async () => {
  let attempts = 0;
  await assert.rejects(() => sendWithSequenceRetry({
    fetchSequence: async () => ({ accountNumber: 7, sequence: 95 }),
    attempt: async () => { attempts++; return { status: 'ambiguous', txHash: 'DEAD1' }; },
    checkTxByHash: async () => ({ status: 'failed', code: 5, error: 'out of gas' }),
    sleep: noSleep, retryDelayMs: 0,
  }), /failed on-chain \(code 5\)/);
  assert.equal(attempts, 1);
});

test('engine: three straight mismatches fail the payment (row stays claimable)', async () => {
  let attempts = 0, fetches = 0;
  await assert.rejects(() => sendWithSequenceRetry({
    fetchSequence: async () => { fetches++; return { accountNumber: 7, sequence: 90 + fetches }; },
    attempt: async () => { attempts++; return { status: 'sequence-mismatch', error: mismatchError(99, 1) }; },
    checkTxByHash: async () => ({ status: 'not-found' }),
    sleep: noSleep, retryDelayMs: 0,
  }), /failed after 3 attempts/);
  assert.equal(attempts, 3);
  assert.equal(fetches, 3);
});

test('engine: a non-mismatch failure propagates immediately, no retry', async () => {
  let attempts = 0;
  await assert.rejects(() => sendWithSequenceRetry({
    fetchSequence: async () => ({ accountNumber: 7, sequence: 95 }),
    attempt: async () => { attempts++; throw new Error('Broadcasting transaction failed with code 13 (codespace: sdk). Log: insufficient fees'); },
    checkTxByHash: async () => ({ status: 'not-found' }),
    sleep: noSleep, retryDelayMs: 0,
  }), /insufficient fees/);
  assert.equal(attempts, 1);
});

test('engine: ambiguous on the LAST attempt is still recovered by the final hash check', async () => {
  let attempts = 0;
  const hash = await sendWithSequenceRetry({
    fetchSequence: async () => ({ accountNumber: 7, sequence: 95 }),
    attempt: async () => { attempts++; return { status: 'ambiguous', txHash: `LATE${attempts}` }; },
    // LATE1 never landed (checked before attempt 2, then dropped);
    // LATE2 DID land — only the post-loop final check can find it.
    checkTxByHash: async (h) => ({ status: h === 'LATE2' ? 'success' : 'not-found' }),
    maxAttempts: 2, sleep: noSleep, retryDelayMs: 0,
  });
  assert.equal(hash, 'LATE2');
  assert.equal(attempts, 2);
});

// ── payout-level integration: a fake chain behind the seams ──
// The LCD is a mocked global.fetch (account reads can be made
// STALE on chosen reads — the lagging node of 2026-11-17); the
// signing client is a real offline CosmJS signer wrapped so its
// broadcasts meet the fake chain's expected sequence.

function makeFakeChain({ startSequence = 95 } = {}) {
  const chain = {
    expected: startSequence,
    accountReads: 0,
    staleOnReads: new Set(), // 1-based account-read numbers that report expected-1
    signs: [],
    broadcasts: [],
    landed: new Map(),       // txHash -> code
    broadcastHook: null,     // optional override (hash, signedSeq, chain) => hash | throws
    inFlight: 0, maxInFlight: 0,
    lastSignedSequence: null,
  };
  chain.clientFactory = async (kind, rpcUrl, wallet) => {
    const offline = await SigningCosmWasmClient.offline(wallet);
    return {
      getChainId: async () => 'columbus-5',
      simulate: async () => 176_780,
      sign: async (from, msgs, fee, memo, signerData) => {
        chain.signs.push(signerData.sequence);
        chain.lastSignedSequence = signerData.sequence;
        return offline.sign(from, msgs, fee, memo, signerData);
      },
      broadcastTxSync: async (txBytes) => {
        const hash = sha256Hex(txBytes);
        chain.inFlight++; chain.maxInFlight = Math.max(chain.maxInFlight, chain.inFlight);
        try {
          await new Promise((r) => setTimeout(r, 2)); // widen any overlap window
          chain.broadcasts.push({ sequence: chain.lastSignedSequence, hash });
          if (chain.broadcastHook) return await chain.broadcastHook(hash, chain.lastSignedSequence, chain);
          if (chain.lastSignedSequence !== chain.expected) {
            throw mismatchError(chain.expected, chain.lastSignedSequence);
          }
          chain.expected += 1;
          chain.landed.set(hash, 0);
          return hash;
        } finally { chain.inFlight--; }
      },
      disconnect: () => {},
    };
  };
  chain.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/cosmos/auth/v1beta1/accounts/')) {
      chain.accountReads++;
      const seq = chain.staleOnReads.has(chain.accountReads) ? chain.expected - 1 : chain.expected;
      return { ok: true, status: 200, json: async () => ({ account: { '@type': '/cosmos.auth.v1beta1.BaseAccount', account_number: '777', sequence: String(seq) } }) };
    }
    if (u.includes('/cosmwasm/wasm/v1/contract/')) {
      return { ok: true, status: 200, json: async () => ({ data: { balance: '1000000000000' } }) };
    }
    if (u.includes('/cosmos/bank/v1beta1/balances/')) {
      return { ok: true, status: 200, json: async () => ({ balance: { denom: 'uluna', amount: '100000000000' } }) };
    }
    if (u.includes('/cosmos/tx/v1beta1/txs/')) {
      const hash = u.split('/').pop();
      if (chain.landed.has(hash)) {
        return { ok: true, status: 200, json: async () => ({ tx_response: { code: chain.landed.get(hash), raw_log: '', txhash: hash } }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }
    throw new Error(`unexpected fetch in fake chain: ${u}`);
  };
  return chain;
}

function fakePayoutFor(chain, extra = {}) {
  return createPayout({
    lcdUrl: 'http://lcd.fake', rpcUrl: 'http://rpc.fake',
    payoutAddress: TERRA_ADDR, mnemonic: TEST_MNEMONIC,
    clientFactory: chain.clientFactory, sleep: noSleep,
    sendTiming: { retryDelayMs: 0, pollIntervalMs: 0, confirmPollAttempts: 3, checkPollAttempts: 3 },
    ...extra,
  });
}

test('payout: the 2026-11-17 incident replays to ONE landed payment', async () => {
  const chain = makeFakeChain({ startSequence: 95 });
  chain.staleOnReads.add(1); // first account read is the lagging node's: 94
  const payout = fakePayoutFor(chain);
  await withFetch(chain.fetch, async () => {
    const hash = await payout.sendReward(RECIPIENT, 1_000_000n, 'memo');
    assert.deepEqual(chain.signs, [94, 95]);       // stale read, then a FRESH read
    assert.equal(chain.broadcasts.length, 2);
    assert.equal(chain.landed.size, 1);            // exactly one payment landed
    assert.equal(hash, chain.broadcasts[1].hash);  // and it is the reported one
    assert.equal(chain.expected, 96);
  });
});

test('payout: every payment reads a fresh sequence (no batch capture)', async () => {
  const chain = makeFakeChain({ startSequence: 95 });
  const payout = fakePayoutFor(chain);
  await withFetch(chain.fetch, async () => {
    await payout.sendReward(RECIPIENT, 1_000_000n);
    await payout.sendReward(RECIPIENT, 2_000_000n);
    assert.deepEqual(chain.signs, [95, 96]); // second send did NOT reuse 95
    assert.equal(chain.landed.size, 2);
  });
});

test('payout: broadcast lost to a network error but landed -> hash returned, signed ONCE', async () => {
  const chain = makeFakeChain({ startSequence: 95 });
  chain.broadcastHook = async (hash, seq, c) => {
    c.expected += 1;
    c.landed.set(hash, 0);              // the tx DID reach the chain…
    throw new TypeError('fetch failed'); // …but the answer never came back
  };
  const payout = fakePayoutFor(chain);
  await withFetch(chain.fetch, async () => {
    const hash = await payout.sendReward(RECIPIENT, 1_000_000n);
    assert.equal(chain.signs.length, 1); // never resent — no double-pay
    assert.equal(hash, chain.broadcasts[0].hash);
    assert.equal(chain.landed.size, 1);
  });
});

test('payout: broadcasts that never land exhaust attempts and fail the send', async () => {
  const chain = makeFakeChain({ startSequence: 95 });
  chain.broadcastHook = async () => { throw new TypeError('fetch failed'); };
  const payout = fakePayoutFor(chain);
  await withFetch(chain.fetch, async () => {
    await assert.rejects(() => payout.sendReward(RECIPIENT, 1_000_000n), /outcome unknown after 3 attempts/);
    assert.equal(chain.signs.length, 3);
    assert.equal(chain.landed.size, 0);
  });
});

test('payout: concurrent sends are serialized — sequences never collide', async () => {
  const chain = makeFakeChain({ startSequence: 95 });
  const payout = fakePayoutFor(chain);
  await withFetch(chain.fetch, async () => {
    const [h1, h2] = await Promise.all([
      payout.sendReward(RECIPIENT, 1_000_000n),
      payout.sendReward(RECIPIENT, 2_000_000n),
    ]);
    assert.equal(chain.maxInFlight, 1);            // never two broadcasts at once
    assert.deepEqual(chain.signs, [95, 96]);
    assert.equal(chain.landed.size, 2);
    assert.notEqual(h1, h2);
  });
});

test('payout: the dormant USTC bank path sends through the same sequence-safe sender', async () => {
  const chain = makeFakeChain({ startSequence: 95 });
  chain.staleOnReads.add(1);
  const payout = fakePayoutFor(chain, { rewardAsset: 'USTC' });
  await withFetch(chain.fetch, async () => {
    const hash = await payout.sendReward(RECIPIENT, 5_000_000n);
    assert.deepEqual(chain.signs, [94, 95]);
    assert.equal(chain.landed.size, 1);
    assert.ok(chain.landed.has(hash));
  });
});

// ── end-to-end: a full daily run over the fixed sender ───────

test('run: a mismatch on the 2nd of 3 payments still pays everyone exactly once', async () => {
  const FRG1 = 1_000_000n;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frg-seqfix-'));
  const store = openStore(path.join(dir, 'test.db'));
  store.setDailyPayoutUsdMicro(500_000n); // $0.50/day — the live model
  store.setMinHoldingBase(0n);
  const W = ['a', 'b', 'c'].map((ch) => 'terra1' + ch.repeat(38));
  const T0 = new Date('2026-11-18T13:00:00Z');
  for (const w of W) { store.registerWallet(w, null); store.recordRegistration(w, T0.getTime() - 3_600_000); }

  const chain = makeFakeChain({ startSequence: 95 });
  chain.staleOnReads.add(2); // payment #2's first account read is stale
  const payout = fakePayoutFor(chain);
  const holdings = Object.fromEntries(W.map((w) => [w, 1_000n * FRG1]));
  const priceFeed = async () => ({
    frgReserveBase: 1_000_000n * FRG1, luncReserveBase: 500_000n * FRG1,
    luncUsdMicro: 100_000n, pair: 'fake-pair',
  });

  await withFetch(chain.fetch, async () => {
    const run = await runPayoutDay(store, payout, async (a) => holdings[a] ?? 0n, { now: T0, priceFeed });
    assert.equal(run.status, 'completed');
    assert.equal(run.totalPaid, 10n * FRG1); // the whole $0.50 pot, exactly
    assert.equal(chain.landed.size, 3);      // one on-chain payment per wallet
    for (const row of run.detail.rows) {
      assert.equal(row.payStatus, 'paid', `${row.wallet} must be paid`);
      assert.ok(chain.landed.has(row.txhash), 'row hash must be a landed tx');
      assert.equal(store.paid(row.wallet), BigInt(row.amount)); // ledger paid exactly the row amount, once
    }
    // Signs: pay1 fresh 95; pay2 stale 95 (rejected: chain already
    // at 96), retry fresh 96; pay3 fresh 97.
    assert.deepEqual(chain.signs, [95, 95, 96, 97]);
  });
});
