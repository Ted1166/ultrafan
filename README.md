# UltraFan ⚽

> _The first truly sovereign football fan app. No servers. No cloud AI. No middlemen._

A World Cup 2026 crew companion built on the full Tether open-source stack which include; Pears P2P networking, QVAC local AI inference and WDK self-custodial wallets running as a native desktop app with zero central infrastructure.

---

## What It Does

UltraFan lets football fans form **crews** over peer-to-peer connections, get **AI match previews and post-match reports** generated entirely on their own device, and **stake prediction pools** in USDt with self-custodial wallets all without a server, a cloud API, or a custodian.

The three tracks work simultaneously in one app:

- **Pears** - crews connect via Hyperswarm, crew history (messages, predictions) syncs over Autobase with no central server. Works over any network, even local WiFi with no internet.
- **QVAC** - Llama 3.2 1B runs on-device via llama.cpp. Match previews, post-match reports, and crew roasts are generated locally with no API key and no data leaving the machine.
- **WDK** - self-custodial EVM wallet, seed phrase generated and stored locally, never transmitted. Prediction pools track stakes peer-to-peer; settlement logic runs in-app.

---

## Architecture

```
renderer/          ← HTML/JS UI (no Node access, contextBridge only)
    ↕ window.bridge (Electron contextBridge)
electron/main.js   ← Electron shell, thin proxy (unchanged from template)
electron/preload.js ← IPC bridge (unchanged from template)
    ↕ FramedStream / Bare.IPC
workers/main.js    ← Bare worker - ALL three tracks live here
    ├── Hyperswarm + Autobase + Corestore  (Pears track)
    ├── @qvac/bare-sdk + llamacpp plugin   (QVAC track)
    └── bare-crypto EVM wallet + JSON-RPC  (WDK track)
```

All inter-layer communication goes through a typed JSON message protocol over the existing IPC pipe - no HTTP server, no localhost ports, no WebSockets.

---

## Stack

| Layer          | Package                                           | Purpose                                                 |
| -------------- | ------------------------------------------------- | ------------------------------------------------------- |
| P2P networking | `hyperswarm`, `autobase`, `corestore`, `hyperbee` | Crew discovery, multi-writer feed, persistent view      |
| Local AI       | `@qvac/bare-sdk`                                  | On-device LLM — no cloud, no API key                    |
| Wallet         | `bare-crypto` + JSON-RPC                          | Key generation, EVM address derivation, balance queries |
| Live data      | `football-data.org` v4 API                        | World Cup 2026 match results (60s polling)              |
| Runtime        | Pear / Bare (via `pear-runtime`)                  | Bare worker process inside Electron shell               |
| UI             | Plain HTML/CSS/JS                                 | Renderer process, no framework                          |

---

## Setup

### Prerequisites

- Node.js ≥ 18
- `npm install -g pear` then `export PATH="/home/$USER/.config/pear/bin:$PATH"`

### Install

```bash
git clone https://github.com/Ted1166/ultrafan
cd ultrafan
npm install
```

`postinstall` runs automatically and patches `@noble` packages for Bare semver compatibility.

### Configure

Get a free API key from [football-data.org](https://www.football-data.org/client/register) — paste it into the app on first run. It's saved automatically.

### First run — download the AI model

On first boot, UltraFan downloads the Llama 3.2 1B Q4 model (~737MB) over Hypercore P2P. If your network blocks UDP, download it directly:

```bash
mkdir -p ~/.cache/qvac/models
wget -O ~/.cache/qvac/models/Llama-3.2-1B-Instruct-Q4_0.gguf \
  "https://huggingface.co/unsloth/Llama-3.2-1B-Instruct-GGUF/resolve/b69aef112e9f895e6f98d7ae0949f72ff09aa401/Llama-3.2-1B-Instruct-Q4_0.gguf"
```

### Run

```bash
pear touch  # only needed once, generates upgrade link
npm start
```

---

## Usage

**Create a crew** - generates a Hyperswarm discovery key. Share it with friends to join.

**Join a crew** - paste the crew key. State syncs automatically over Pears.

**Wallet** - created automatically on first run, restored from local storage on subsequent runs. Seed phrase shown once — save it.

**Live matches** - paste your football-data.org API key. Matches refresh every 60 seconds. Click any match to see the AI preview and open the prediction pool.

**Prediction pool** - enter an amount and stake your pick before kickoff. Pool settles automatically when the match result comes in.

**AI reports** - generated on-device after each match using QVAC. No cloud call, no API key.

---

## Tracks

This project enters all three tracks:

- **Pears** - Hyperswarm crew discovery, Autobase multi-writer feed, Corestore persistence
- **QVAC** - on-device Llama 3.2 1B inference via `@qvac/bare-sdk` with explicit plugin registration for the Bare runtime
- **WDK** - self-custodial wallet using `bare-crypto` for key generation, EVM address derivation, and JSON-RPC balance queries against Sepolia testnet

---

## Known Limitations

- **Wallet signing**: the current wallet derives an EVM address using SHA-256 (Bare-native) rather than the full secp256k1+keccak256 stack. Balance reading works; on-chain transaction signing requires a Bare-compatible secp256k1 library (the production path is `@tetherto/wdk-wallet-evm` once its `@noble/hashes` dependency ships a Bare-compatible build).
- **AI on CPU**: WSL2 and headless Linux environments have no Vulkan GPU - the model runs on CPU. On a machine with a Vulkan-compatible GPU, QVAC uses it automatically for ~10x faster inference.
- **Pool settlement**: prediction pools settle in-memory with P2P state sync. Real USDt transfer on settlement is the production step, pending wallet signing.

---

## License

MIT
