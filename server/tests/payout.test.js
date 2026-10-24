// Payout config tests: address/key independence + mismatch guard.
// No network: mismatch and no-key cases fail before any chain call.
// Uses the public CosmJS test mnemonic (a test vector, never a real key).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayout } from '../src/payout.js';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ENV_ADDR = 'terra1' + 'q'.repeat(38);

test('address-only config: balance address works, sending refuses', async () => {
  const p = createPayout({ lcdUrl: 'http://127.0.0.1:1', rpcUrl: '', payoutAddress: ENV_ADDR, mnemonic: '' });
  assert.equal(await p.address(), ENV_ADDR);
  assert.equal(p.configured, false);
  assert.equal(p.canSend, false);
  await assert.rejects(() => p.send(ENV_ADDR, 1n), /payout wallet not configured yet/);
});

test('key-only config: address derives from the key, no network needed', async () => {
  const p = createPayout({ lcdUrl: 'http://127.0.0.1:1', rpcUrl: '', payoutAddress: '', mnemonic: TEST_MNEMONIC });
  const addr = await p.address();
  assert.match(addr, /^terra1[0-9a-z]{38}$/);
  assert.equal(p.configured, true);
});

test('address/key mismatch refuses before any send', async () => {
  const p = createPayout({ lcdUrl: 'http://127.0.0.1:1', rpcUrl: '', payoutAddress: ENV_ADDR, mnemonic: TEST_MNEMONIC });
  const derived = await p.address(); // env address wins for display
  assert.equal(derived, ENV_ADDR);
  await assert.rejects(() => p.send(ENV_ADDR, 1n), /misconfigured: key does not match payout address/);
});

test('no address and no key: everything refuses safely', async () => {
  const p = createPayout({ lcdUrl: 'http://127.0.0.1:1', rpcUrl: '', payoutAddress: '', mnemonic: '' });
  assert.equal(await p.address(), null);
  await assert.rejects(() => p.getBalance(), /payout wallet not configured yet/);
  await assert.rejects(() => p.send(ENV_ADDR, 1n), /payout wallet not configured yet/);
});
