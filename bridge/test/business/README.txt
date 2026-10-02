Offline business replay
=======================

Run from bridge/:
  yarn jest --config=bridge.jest.config.js --runInBand test/business

This compares the deployed f3525760157ec33cc61a9df3355e479e4be5fcf2 monitor,
observer and planet routing with current production code. Five baseline source
files are frozen under test/fixtures/pre-pr10 with relocated imports only.
manifest.json records original-source and normalized executable SHA-256 hashes.
An integrity test prevents accidental baseline logic edits. Unchanged SQLite,
types and notification classes are shared. This is not an entire old executable
or an independent implementation of every dependency.

Each run uses separate temporary file-backed SQLite state/history databases.
Initial checkpoint and optional initialHistory are identical for both versions.
The payout boundary records source transaction, actual recipient, amount and
memo; it cannot sign or send funds. RPC responses and notification clients are
also offline. No production entrypoint, credentials or URLs are used.

Compare both versions to an independent oracle that decodes ABI words directly
and truncates amounts using integer arithmetic (without production event parsing,
Decimal or MultiPlanetary). Literal expected examples verify the oracle itself.
Checks include exact ordered payout lists, persisted recipient/sender/amount/
status, final checkpoint, notification categories, and unchanged seeded history.
Deliberately corrupted payout lists prove wrong amounts/recipients/memos,
omissions and duplicate payouts fail. The baseline's known null-cursor omission
is asserted as a historical defect, not accepted as correct business behavior.

The generated cases are SYNTHETIC, not captured production history:
- Legacy destination, explicit Odin and Heimdall vault/user-memo routing.
- 18-to-2 decimal conversion and truncation, minimum cent, larger amounts.
- Near-tip scanning, multiple transactions in one block, 1,000-block boundaries,
  empty suffixes and exclusion of burns with fewer than 10 confirmations.
- Closing/reopening the databases at blocks 50 and 1,000.
- Existing COMPLETED, PENDING and FAILED history is never resubmitted; later
  eligible transactions still produce their expected payouts.

Historical captures
-------------------
  BSC_REPLAY_FIXTURE=/absolute/path/capture.json yarn jest \
    --config=bridge.jest.config.js --runInBand test/business/payout-replay.spec.ts

Without this variable the historical case uses the checked-in mainnet capture
test/fixtures/captured/bsc-1a8a7e3.json and always runs in CI. The separate
historical-burn-replay.spec.ts also locks its literal expected payout and verifies
the confirmation boundary and a restart after the captured burn. See the
capture README for source, completeness checks and routing assumptions.
The JSON file follows the exported ReplayFixture interface in replay.ts:
- provenance: { kind: "captured", description: "source, chain ID, capture date,
  block interval, independent log-completeness checks" }
- contractAddress, planetIds: { odin, heimdall }, heimdallVault
- confirmations: 10; tip: the captured chain tip as an integer
- checkpoint: { blockHash, txId: null or a transaction hash }
- headers: every canonical header from the checkpoint through tip, with number,
  hash, parentHash. All numbers must be decimal JSON numbers, not RPC hex strings.
- logs: complete raw SentToLibPlanet logs for that interval, in ethers Log shape
  (address, topics, data, blockNumber, blockHash, transactionHash,
  transactionIndex, logIndex, removed). Retain unconfirmed logs to test exclusion.
- optional initialHistory: exchange-history rows (network, tx_id, sender,
  recipient, numeric amount, ISO timestamp, status).

Do not include credentials or private keys. Prefer an empty checkpoint block
before the interval or a valid paid-transaction cursor for equality tests. A
baseline defect can legitimately produce a mismatch: inspect it against the
independent expected manifest rather than weakening the assertion. The capture
must contain at least one eligible payout. Validate capture completeness using
an independent source; header continuity alone cannot prove no log was omitted.

Limits
------
This verifies payout INTENT and persistence, not KMS signing, Headless staging,
transaction execution or destination balances. COMPLETED here is the existing
application status after a fake transfer accepts the request. PENDING/FAILED
rows remain unresolved; retaining them is not proof of completed payout.
The existing transaction-level deduplication policy is preserved. This harness
does not establish correctness for multiple independent burns in one source
transaction, deep chain reorganizations, or separate production history DBs.
Real transport/failover and crash fault cases live in the existing provider and
monitor suites. Real destination settlement needs a separate isolated E2E run.
