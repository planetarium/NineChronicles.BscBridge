# Bridge

This application relays between `wNCG` on [Ethereum] and `NCG` on Nine Chronicles network.

## Prerequisite

```
# Nodejs LTS
$ node --version
v16.17.0

# https://yarnpkg.com/
$ yarn --version
1.22.19

# Python 2 should be installed and alias via python
$ python --version
Python 2.7.18

# SQLite3 should be installed because it uses SQLite3 as database.
$ command -v sqlite3
/usr/bin/sqlite3
```

## Installation

```
yarn
```

## Build

```
yarn build
```

## Run test

```
yarn test
```

### Run only tests related to bridge

```
yarn test:bridge
```

### Run only tests dependent to AWS

```
yarn test:aws
```

### To run a single test

```
# Insatll Yarn
$ npm install --global yarn

# Run via yarn jest
$ yarn jest test/observers/burn-event-observer.spec.ts
```

## Run

```
yarn start
```

## Build (Docker)

It builds Docker image and push it automatically with GitHub Actions workflows. You can look up images in [Docker Hub](https://hub.docker.com/r/planetariumhq/9c-ethereum-bridge/tags) and the tag matches with the rule, `git-{GIT_SHA}` (e.g, `git-ccbc0e90c8a011736ba1f39dfd7980a9d415d94a`).

```
docker build .
```

[Ethereum]: https://ethereum.org/

## RPC routing

Set `KMS_PROVIDER_URL` to the NodeReal endpoint and `KMS_PROVIDER_SUB_URL`
to the Infura endpoint for the same chain. Use the URLs issued by each dashboard;
credentials belong in the deployment secret store. An empty secondary URL keeps
single-endpoint operation. Set `BSC_CHAIN_ID` explicitly for test networks
(default: 56). Each endpoint's chain ID is checked before use; a wrong chain
fails closed. The secondary is first checked when failover is needed.

Reads use the primary only while healthy. Timeouts, connection failures, quota
errors and server outages switch reads to the secondary. Requests time out after
10 seconds; after a primary failure the secondary is used for at least 30 seconds
before probing the primary again at the next read-session boundary. Invalid requests, contract reverts and log range limits
are passed to the caller instead of retried on another endpoint. Transaction
broadcasts are sent once; an ambiguous timeout must be reconciled using the
transaction hash/history, not by creating another payment.

The BSC monitor keeps the existing 10-block confirmation offset and queries up to
1,000 blocks of logs at once, including during normal operation. After draining
the observed tip it releases its RPC session and waits 15 seconds, even if the
chain advanced during the reads. Larger backlogs continue in 1,000-block batches
without this wait. This bounds steady-state polling instead of chasing each new
block on fast chains. It validates the
range-end hash before/after log retrieval and before delivery, reads individual
headers only for event-bearing blocks, and checkpoints an empty suffix once at
its end. The cursor advances only after the observer consumes the yielded item.
Tip, anchor and log reads are pinned to the same RPC endpoint until the range is
consumed or fails. A transient failure releases the session and retries the
unconsumed range with backoff, rather than mixing endpoints inside a range.
A slow healthy secondary keeps its session beyond the normal 30-second cooldown.
An endpoint-generation counter also rejects an intervening A-to-B-to-A switch.
The selected endpoint's actual height is used, bypassing ethers' monotonic tip
cache, so a lagging secondary cannot borrow the primary's confirmations.
A changed anchor discards the unconsumed cached range and refetches it. This is
confirmation-based monitoring, not a finalized-block guarantee.

An empty 10,000-block catch-up needs 10 log queries, 30 block-header queries,
10 tip queries and 99 chain-ID checks: 149 raw RPC calls, excluding initial
resume (which includes acquisition of the first read session). The integration test counts the actual ethers transport calls.
Event-bearing ranges require additional header checks. KMS address derivation no longer starts an unused EVM
block tracker. Keep both SQLite state/history files persistent and run one active
bridge instance; independent history databases cannot deduplicate each other's
payments. Existing pending/failed payments are not automatically resubmitted.

Checkpoint restoration uses the same retry/backoff and confirmation policy as
normal scanning. It validates the saved header against the canonical header,
checks all returned log hashes, and refuses to skip past a missing transaction
cursor. A null transaction cursor replays that block through the existing
persistent payout-history guard. For an orphan checkpoint, the monitor follows
archived parent headers to a common ancestor and rescans the replaced branch.
Recovery is bounded to 1,000 parent edges. If headers are unavailable or no common
ancestor can be found within that limit, the bridge keeps retrying without
advancing the checkpoint; operators must restore valid checkpoint data rather
than delete payout history. This recovery does not reverse already issued
payments or establish finality for reorganizations beyond the confirmation policy.

Stopping the monitor interrupts idle/backoff waits, suppresses pending deliveries
and releases its read session. Observer failures release the session without
repeating a potentially ambiguous payment. The runtime uses one monitor/provider;
read sessions are not independent routing contexts for multiple bridge instances.
