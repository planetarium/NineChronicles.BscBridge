Historical BSC capture: 0x1a8a7e3abf55edfb9e71bc501059faafb37f8456339d5a0347eb62a8f507bba5
Captured 2026-10-02, chain ID 56.
Explorer: https://bscscan.com/tx/0x1a8a7e3abf55edfb9e71bc501059faafb37f8456339d5a0347eb62a8f507bba5

The receipt is successful at block 124654860. The bridge contract
0xae8f4354d2c5175ae1c13f7f849b50e5f23aee5c emitted one SentToLibPlanet log:
amount 1629320000000000000000 (1629.32 NCG), planet 0x000000000001,
user 0xeee0f468d0214c389693b119cec2094af727574f.

RPC sources (read-only, no API credentials):
https://bsc-dataseed.bnbchain.org
https://bsc-dataseed1.defibit.io

Capture procedure and completeness checks:
1. Read eth_chainId, eth_getTransactionReceipt and eth_getBlockByNumber(false)
   for every block 124654859 through 124654871 inclusive.
2. eth_getLogs was rate-limited, so read eth_getBlockReceipts for all 13 blocks
   from BOTH endpoints. Every corresponding full receipt array matched exactly.
3. Match each block's receipt count and transaction-hash set against its header's
   transaction list; match every receipt's blockHash and blockNumber to that
   header. In total 1,125 receipts were checked. Filter every receipt's logs by
   the bridge address and SentToLibPlanet topic. Exactly one matching log exists
   in the entire interval, equal to the independently queried transaction receipt.
4. Retain header number/hash/parentHash and the normalized matching log in the
   fixture. Only RPC hex integer fields are converted to JSON numbers. Retain
   the unmodified transaction receipt separately. Per-block full-receipt SHA-256
   digests use Python json.dumps(receipts, sort_keys=True, separators=(',', ':'))
   UTF-8 bytes. Digests and counts record acquisition evidence; CI validates the
   compact fixture/receipt and does not re-download all receipts.

Routing source: https://planets.nine-chronicles.com/planets
The public registry identifies Odin=0x000000000000, Heimdall=0x000000000001,
and Odin.bridges[Heimdall].agent=0x1c2ae97380CFB4F732049e454F6D9A25D4967c6f.
This agrees with planets/mainnet.json in planetarium/9c-infra at commit
22e4081c4e6db1e59dede104cf480e41b1b94141. Existing unit fixtures use INTERNAL
planet IDs (0x1000...), which must not be used for this mainnet event.

Under that public mainnet configuration, both bridge versions must record one
1629.32 NCG transfer to the Heimdall vault with the USER address as memo. The
SQLite history recipient remains the user address, as required by the observer.

The checkpoint is the preceding empty block with txId=null and an empty history
DB, deliberately allowing the historical event to be replayed offline. The tip
is a historical header at burn height + 11, not a claim about the live tip.
No actual deployment environment or production history DB was read. Thus this
verifies mainnet-configured business equivalence, not the current deployment's
environment values or whether the user actually received funds on Heimdall.
No KMS, payout, broadcast or notification side effects occur in these tests.
