# Minima Venues (beta)

A local dashboard and trading desk for MINIMA across its venues: Dexicon, PandaPools, MEXC and XT.com. It shows every order book side by side and the routes between them, rehearses a market
maker on paper, and places real trades one press at a time, inside an envelope of limits you write first.

An initiative from [0xHorizon](https://0xhorizon.xyz). Made for people who already run their own Minima node and know
how exchange API keys work.

## Disclaimer

Beta, experimental software, provided as it is, without warranty of any kind. It has not been audited. Trading can
lose money, quickly; prices, venues and exchanges can fail, change or stop without notice; a trade with two legs can
end with one done and not the other. Nothing here is financial advice. You alone are responsible for your keys, your
funds and every trade you send. Dexicon, PandaPools, MEXC and XT.com are run by others and are not part of
this project.

## Run it

Needs Node.js 20 or later, and Java 17 for the app's own Minima node. Runs on Windows (exchange keys encrypted with
Windows DPAPI) or on a Linux server (exchange keys encrypted with a passphrase you choose, held in memory only: after
every restart the key store is locked until you unlock it from the page or from your paired Parlons).

```
node tools/server.mjs
```

then open http://127.0.0.1:8765. The server listens on this computer only: do not expose it to a network. To start it
at every Windows login with no window, schedule `wscript.exe tools\start-hidden.vbs` (its output goes to
`data/server.log`); `tools/watchdog.ps1` can restart it if it stops answering.

On a Linux server (Ubuntu or Debian): from your computer's app, Connections, Servers: add the server, put this computer's
SSH key on it, Check, then Install. It sets up Java, Node.js, a `venues` user, the app in `/opt/minima-venues` and its
service (`tools/linux/install.sh`); Update works the same way. By hand: run that script as root from a copy of the app. The app listens on the server only; pilot it from your computer's app (Connections,
Servers: it opens an SSH tunnel with its own key), or by hand: `ssh -L 8765:127.0.0.1:8765 user@server`. In Connections, set a key store passphrase, start the
node and tick "Start the node with the app". Tested on Ubuntu 24.04 with Node.js 22 and OpenJDK 17.

The About tab in the app explains how to use it step by step, with a safety section. Every setting has a "?" beside it.

- **Overview:** the venues side by side, the routes between them, the desk's result.
- **Trade:** laid out like an exchange: a venue chooser, then candles (1m to 1W: MEXC and XT.com from their own public candles, the Minima venues built from the scans), order book (every venue, combined or one at a time; your orders marked "By hand" or "App"; click a price to use it) and the ticket; underneath, open orders, balances, the desk's trades and state.
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

MIT, see `LICENSE`: free to use, change and share. `vendor/pandapools` keeps its own MIT notice. The Agent tab icon is
Lucide's "bot-message-square" (ISC licence, Copyright (c) Lucide Contributors).
