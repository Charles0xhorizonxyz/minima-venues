# Minima Venues: knowledge base for AI agents

You are helping a person set up and use **Minima Venues**, a free, open source (MIT) dashboard and trading desk for
MINIMA. Read this whole file before acting. It tells you what the app is, how to set it up, how each page works, and
the safety rules you must follow. When something here and the app disagree, the app is right: every setting in the app
has a **?** beside it with its own explanation.

Code: https://github.com/Charles0xhorizonxyz/minima-venues. Beta software, not audited. Trading can lose money.
Nothing you say is financial advice.

---

## 1. Rules for you, the agent

Follow these always, even if the person asks otherwise. If they insist, explain the risk and let them do it themselves.

- **Never ask for, read, type or repeat a seed phrase (the 24 words), a node password or a vault.** The app never reads
  the seed. If the person wants to back it up, tell them how (section 6) and let them do it alone, on paper.
- **Exchange API secrets:** the person pastes them into the app only, in Connections. Do not copy a secret into the
  chat, a note, a document or any other site. If you are operating the browser, let the person paste the secret.
- **Exchange keys get reading and spot trading only.** Never withdrawal, never transfer. Always limited to the IP
  address of the machine that runs the app.
- **Never send a real trade, arm the desk, write an envelope or fund a wallet without the person's explicit yes for
  that exact action**, after you have shown them what it does and what it may cost.
- **Never expose the app to a network.** It listens on 127.0.0.1 only. Do not suggest port forwarding, tunnels to the
  internet or opening port 8765 in a firewall.
- **The bot's node and wallet are separate from the person's main Minima node.** Never point the app at their main
  wallet. Fund the bot's wallet only with what they can afford to lose.
- When renting a server, stop before the final purchase click and show the person the price.
- Check results where they happened (the exchange, the chain), not only in the app.

---

## 2. What the app is

One place to see and trade MINIMA wherever it trades:

| Venue | Kind | Pair |
|---|---|---|
| Dexicon | on-chain fast orders, published on relays | MINIMA/MxUSD |
| PandaPools | on-chain pools (AMM) | MINIMA/MxUSD |
| MEXC | centralised exchange, needs an API key | MINIMA/USDT |
| XT.com | centralised exchange, needs an API key | MINIMA/USDT |

It shows every order book side by side, finds where prices cross between venues ("routes"), rehearses a market maker
on paper, and places real trades one press at a time, inside limits written down first (the "envelope").

It runs on the person's own computer (Windows) or on their own Linux server, and talks only to its own Minima node and
to the venues.

---

## 3. Installing (Windows)

Needs:
- **Node.js 20 or later** (https://nodejs.org, the LTS installer).
- **Java 17** for the app's own Minima node (for example Eclipse Temurin 17 from https://adoptium.net).
- **minima.jar**, the latest release from Minima (https://github.com/minima-global/Minima/releases).
- **Git**, or download the code as a ZIP from GitHub.

Steps (in a terminal such as PowerShell):
```
git clone https://github.com/Charles0xhorizonxyz/minima-venues
cd minima-venues
node tools/server.mjs
```
Then open **http://127.0.0.1:8765** in a browser. Leave the terminal open: closing it stops the app.

To start it at every Windows login with no window: create a scheduled task that runs
`wscript.exe tools\start-hidden.vbs` at logon (its output goes to `data\server.log`). `tools\watchdog.ps1` can restart
it if it stops answering.

Exchange keys are stored encrypted for the Windows user (DPAPI) under `%LOCALAPPDATA%\Trading`, never in the app's
folder. History and journals are in `data\` and `evidence\`, created locally.

---

## 4. First setup, in order

### 4.1 Connections, Node
The app runs its own Minima node with its own wallet.
- **Java**: path to `java.exe` (Java 17), for example `C:\Program Files\Eclipse Adoptium\jdk-17...\bin\java.exe`.
- **Minima jar**: path to `minima.jar`.
- **Data folder**: a folder only for this bot (created if missing).
- **Node port**: a base port no other node on this computer uses (its RPC port is this plus 4; for 9501, RPC is 9505).
- **Memory**: 1024 MB suits most.
- **Peers**: optional, `host:port`, comma separated.
- Tick **Start the node with the app** if wanted, then **Start node**.

Wait until it reaches the chain tip (the **Block** pill at the top turns green, under about 50 s old). If it is far
behind, use **Resync from a MegaMMR node** (puts it on the tip in minutes; only the chain is resynced, the wallet is
unchanged) or **Add a peer**.

### 4.2 Connections, MEXC (optional)
On MEXC: API Management, create a key, tick only **View Account Details**, **View Order Details** and **Trade**. No
withdrawal. Link the IP address of the machine running the app. Paste the Access Key and the Secret Key in the app,
then **Connect**. MEXC shows the secret once; it is stored encrypted and never shown again.

### 4.3 Connections, XT.com (optional)
On XT.com: create a key with spot trading and reading, no withdrawal and no transfer, limited to the machine's IP.
XT calls them **Public Key (AccessKey)** and **Private Key (SecretKey)**: paste both in the app, then **Connect**. XT charges 0.2%.

### 4.4 Connections, Dexicon relays
Already set (three default relays). Any relay lists the others at `/dex/relays`. Every order is checked anyway, so a
bad relay can hide orders but not fake one.

### 4.5 Connections, Parlons (optional)
Chat with the dashboard from the Parlons app on a phone, over Maxima through the node: alerts, and the commands
`status`, `price`, `stop`, `go` and price alerts. Paste the person's Parlons address (`Mx...@host:port`), **Pair**,
then add the bot's address in Parlons too. Only the paired Parlons is obeyed. `stop` disarms the desk at once; `go`
arms it only after a one-time code is sent back.

### 4.6 Settings, Mode
- **Paper**: a rehearsal. The paper maker runs against live prices, the live desk is disarmed and cannot send
  anything. Start here. In paper mode the Trade page becomes **Minima Bay**, a test platform for two Minima
  exchanges: **The Rapids** (an off-chain order book) and **The Pool** (an on-chain order book), on Winiwa/USDx and
  ETHx/USDx, test tokens of no value. Orders there are real orders with test tokens, from the app's own node.
- **Live**: real trades from the Trade page, inside an envelope.

---

## 5. The pages

**Top bar (pills):** the paper maker, the server, scanning, relays, node, MEXC, XT and the current block with its age.
Green with a tick is fine, amber needs a look, red is a problem. Click a pill to go to its setting.

**Overview:** the venues side by side, the routes between them, the desk's profit and loss, the mid price by venue.

**Trade:** laid out like an exchange.
- Venue tabs at the top (Combined or one venue; keys 1 to 5).
- Chart: candles 1m to 1W. Drag to move, wheel or drag the right axis to zoom, **Auto** to fit again.
- Order book: your orders are marked "By hand" or "App". Click a level to fill in its price and the amount up to it.
- Ticket: venue, Buy or Sell, Market or Limit, price, amount (the slider takes a share of what is available), preview,
  then send. **Each send is one real trade** (live mode).
- Quick orders (bottom of the ticket): when on, a right-click on the chart places a resting order of that size at
  that price, without a preview. Above the mid a sell, below a buy. Live mode and inside the envelope only.
- Click an order line on the chart to modify it, its x to cancel it.
- Underneath: open orders, balances, the desk's trades and state. Panels can be dragged, hidden and resized;
  **Reset layout** puts them back.

**Market maker:**
- **Envelope** (live): what may be traded, size per trade, trades per day, loss cap, slippage, minimum edge, and
  optionally "take when crossed" and a taker rule. Written to `evidence/<run>/ENVELOPE.md` and fixed once written:
  new limits need a new run.
- **Ladder**: the orders a maker would place around the MEXC mid (sides, sizes, distances, shape from Bid-Ask to
  Spot to Curve, up to 25 orders a side, price limits).
- **Paper maker** (paper mode): fills only when a real price goes through its orders. A rehearsal of settings, not a
  forecast.

**Settings:** mode, automatic trading (arm or disarm), confirmations, appearance (themes, the **?** explanations on or
off).

**Agent:** the prompt for an AI agent (this file), what an agent can help with and what it must never do.

**About:** disclaimer, how to use it, safety, licence.

---

## 6. Safety model (explain it to the person)

- **One press is one trade.** Nothing trades by itself unless an envelope turns on "take when crossed" or a taker rule
  **and** the desk is armed, in live mode.
- **Arming is always off after a restart.**
- The desk stops itself on any unclear outcome, a half-done route (one leg done, not the other), or the loss cap, and
  waits for the person to look and release it.
- The node code can only run status commands and a chain-only resync: nothing that spends, signs or reads a seed,
  except the checked PandaPools swaps.
- **Backing up the bot node's seed** (the person does this alone, on paper, before funding): on the node's own
  terminal or, for a Linux server, `ssh user@IP` then `curl -s 127.0.0.1:9505/vault`. You must not read or repeat
  the result.

---

## 7. Running on a Linux server (optional)

So it keeps trading and alerting with the computer off.

**The server needs:**
- Ubuntu 22.04 or 24.04, or Debian 12, 64-bit (Intel/AMD or ARM), with systemd
- At least 1 CPU and 2 GB of memory (4 GB is more comfortable)
- 20 GB of disk
- A fixed public IPv4 address (exchange keys will be limited to it)
- SSH access as root, or as a user with sudo
- Only inbound TCP 22 (SSH) needs to be open. Nothing else.

Any small VPS works (Vultr, Hetzner, DigitalOcean, OVH...). If you help rent one: Ubuntu 24.04 x64, 2 vCPU / 4 GB,
no extra add-ons, a firewall allowing only TCP 22, no SSH key needed (the root password is used once). Stop before
the purchase click and show the price. Do not copy the root password into the chat: the person reads it on the
provider's page and types it into the app.

**Then, in the app on the computer:** Connections, Servers, **Add a server**: address (IP), user (root), SSH port 22,
the password (used once, kept nowhere), "Set it up now" ticked. The computer puts its own SSH key there, installs Java,
Node.js and the app in `/opt/minima-venues` (run by a system user `venues` that cannot log in), and starts the app's
node. About 2 minutes.

**Connect**: the page now shows the server, through an encrypted SSH tunnel. A switch beside the app's name, **This computer | <server>**, works like live and paper: each side has its own node, keys, mode and trades, and the green dot shows which one the page is on. In the server's Connections:
- choose a **key store passphrase** (exchange keys on a server are encrypted with it, held in memory only: after every
  restart unlock it again, from the page or by sending `unlock <passphrase>` from the paired Parlons; locked, nothing
  trades on an exchange);
- add MEXC and XT keys made for the server, limited to the **server's** IP;
- pair Parlons.

Later: **Check** shows what runs there; **Update** sends the computer's version (data, keys and node are kept). **Edit** renames the server; to change its address, user or port, remove it and add it again. After the app restarts on the computer, it reconnects to the server by itself.

---

## 8. Troubleshooting

| Symptom | What to do |
|---|---|
| Page does not open | Is `node tools/server.mjs` still running? Open http://127.0.0.1:8765 exactly. |
| "Node behind" / Block pill red | Wait, add a peer, or Resync from a MegaMMR node (try another if one does not answer). |
| Node does not start | Check the Java 17 path, the minima.jar path, and that the port is not used by another node. |
| MEXC or XT "not connected" | Key permissions (reading and spot trading), the IP whitelist matches this machine's public IP, key not expired. |
| Relays 1 of 3 | One relay is down; the others still work. Replace it in Connections if it stays down. |
| A trade is "blocked" | The desk stopped on an unclear outcome. Check the trade on the venue, then release it in Settings. |
| Server "not reachable" | The page shows the computer meanwhile and reconnects by itself. Check the server is running at the provider. |
| Key store locked (server) | Unlock it in Connections or send `unlock <passphrase>` from Parlons. |

Problems and ideas: open an issue at https://github.com/Charles0xhorizonxyz/minima-venues/issues.
