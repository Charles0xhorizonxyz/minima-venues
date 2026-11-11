# PandaPools engine files, unedited

Copied from `github.com/eurobuddha/pandapools-mds` at commit `c2a5051` (0.6.42), MIT licence (`LICENSE`, kept as
required). `decimal.js` is decimal.js by Michael Mclaughlin, MIT, as shipped inside PandaPools.

`tools/pool-trade.mjs` runs these four files in a `node:vm` context, so the bot prices, rounds and routes a swap
with the exact code PandaPools' own page uses. The covenant rejects an amount one grain off, so these must not be
edited. `SHA256SUMS` pins them, and `pool-trade.mjs` refuses to load a file whose hash differs.

To update: copy the four files from a newer commit, rewrite `SHA256SUMS`, update this note, and re-run the pool
tests (`tools/test-pool-trade.mjs`) before any live trade.
