# Minima Venues (beta)

A local dashboard and trading desk for MINIMA across its venues: Dexicon fast orders, PandaPools, the PandaDEX
on-chain book, MEXC and XT.com. It shows every order book side by side and the routes between them, rehearses a market
maker on paper, and places real trades one press at a time, inside an envelope of limits you write first.

An initiative from [0xHorizon](https://0xhorizon.xyz). Made for people who already run their own Minima node and know
how exchange API keys work.

## Disclaimer

Beta, experimental software, provided as it is, without warranty of any kind. It has not been audited. Trading can
lose money, quickly; prices, venues and exchanges can fail, change or stop without notice; a trade with two legs can
end with one done and not the other. Nothing here is financial advice. You alone are responsible for your keys, your
funds and every trade you send. Dexicon, PandaPools, PandaDEX, MEXC and XT.com are run by others and are not part of
this project.

## Run it

Needs Node.js 20 or later and Windows (exchange keys are encrypted with Windows DPAPI). A Minima node and Java 17 for
the bot's own node.

```
node tools/server.mjs
```

then open http://127.0.0.1:8765. The server listens on this computer only: do not expose it to a network. To start it
at every Windows login with no window, schedule `wscript.exe tools\start-hidden.vbs` (its output goes to
`data/server.log`); `tools/watchdog.ps1` can restart it if it stops answering.

The About tab in the app explains how to use it step by step, with a safety section. Every setting has a "?" beside it.

- **Overview** and **Order books:** every venue, combined or one at a time; your exchange orders marked "By hand" or "App".
- **Trade:** an exchange-style ticket on any venue, inside the envelope.
- **Market maker:** the envelope (caps, take when crossed, a taker rule) and the ladder; a paper maker in paper mode.
- **Connections:** the bot's own Minima node (start, stop, peers, MegaMMR resync), the MEXC and XT.com keys, the relays.
- **Settings:** live or paper mode, the look, arming the desk.

## Safety in the code

- One press is one trade. Nothing trades by itself unless an envelope turns on "take when crossed" or a taker rule and
  the desk is armed in live mode. The desk is always disarmed after a restart.
- Any unclear outcome, half-done route or loss cap stops the desk until a person releases it.
- Exchange keys: reading and spot trading only, never withdrawal; stored encrypted under `%LOCALAPPDATA%\Trading`, never
  in this folder, never sent to the page.
- The node code can only run `block status balance keys connect quit` and a chain-only `megammrsync` resync: nothing
  that spends, signs or reads a seed. Pool swaps are built and checked in `tools/pool-trade.mjs`.
- `SHARED_RPC_PORTS` in `tools/node.mjs` and `tools/pool-trade.mjs` lists node ports the bot must never write through.
  Edit it to match your own machine.

## Where things are

| Path | What |
|---|---|
| `tools/server.mjs` | the local server: scans once a minute, serves the page |
| `tools/scan.mjs` | read-only snapshot of all venues |
| `tools/desk.mjs` | the live desk: envelope, arming, previews, sends, journal, stop rules |
| `tools/pool-trade.mjs` | PandaPools swaps from the bot's own node |
| `tools/mexc.mjs`, `tools/xt.mjs` | the exchange accounts |
| `tools/mm.mjs`, `tools/node.mjs` | the paper maker; the bot node's start, stop, status and resync |
| `dashboard/index.html` | the whole page |
| `vendor/pandapools/` | PandaPools' own pricing files, MIT, unedited and hash-pinned |

`data/` and `evidence/` (history, journal, balances) are created locally and never committed.

## Licence

MIT, see `LICENSE`: free to use, change and share. `vendor/pandapools` keeps its own MIT notice.
