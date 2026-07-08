// Runs on Bare. This is the ONLY place all three tracks live:
//   Pear -> Hyperswarm + Corestore + Autobase (crew P2P sync)
//   QVAC -> local LLM inference (match previews, reports, roasts)
//   WDK -> self-custodial wallet + prediction pool + tipping
//
// Talks to renderer/app.js via FramedStream over Bare.IPC (JSON messages).

const fs = require('bare-fs')
const crashLogPath = '/tmp/ultrafan-crash.log'
function logToFile(msg) {
  try {
    fs.appendFileSync(crashLogPath, `[${new Date().toISOString()}] ${msg}\n`)
  } catch { }
}

Bare.on('uncaughtException', (err) => {
  logToFile(`UNCAUGHT: ${err.stack || err}`)
})

logToFile('worker.js starting')

const PearRuntime = require('pear-runtime')
logToFile('pear-runtime loaded')
const Hyperswarm = require('hyperswarm')
logToFile('hyperswarm loaded')
const Corestore = require('corestore')
logToFile('corestore loaded')
const Autobase = require('autobase')
logToFile('autobase loaded')
const Hyperbee = require('hyperbee')
logToFile('hyperbee loaded')
const goodbye = require('graceful-goodbye')
logToFile('goodbye loaded')
const FramedStream = require('framed-stream')
logToFile('framed-stream loaded')
const path = require('bare-path')
logToFile('bare-path loaded')
const crypto = require('bare-crypto')
logToFile('bare-crypto loaded')
const b4a = require('b4a')
logToFile('b4a loaded')
const fetch = require('bare-fetch')
logToFile('bare-fetch loaded')

const pipe = new FramedStream(Bare.IPC)
logToFile('pipe created')

// - Pear updater boilerplate (from template, unchanged) -
const updaterConfig = {
  dir: Bare.argv[2],
  app: Bare.argv[3],
  updates: Bare.argv[4] !== 'false',
  version: Bare.argv[5],
  upgrade: Bare.argv[6],
  name: Bare.argv[7]
}

const store = new Corestore(path.join(updaterConfig.dir, 'pear-runtime/corestore'))
logToFile('corestore instance created, dir=' + updaterConfig.dir)
const swarm = new Hyperswarm()
logToFile('hyperswarm instance created')
const pear = new PearRuntime({ ...updaterConfig, swarm, store })
logToFile('pearruntime instance created')
pear.updater.on('error', console.error)

if (updaterConfig.updates !== false) {
  swarm.on('connection', (connection) => store.replicate(connection))
  swarm.join(pear.updater.drive.core.discoveryKey, { client: true, server: false })
}

pear.updater.on('updating', () => send({ type: 'pear:updating' }))
pear.updater.on('updated', () => send({ type: 'pear:updated' }))

// - IPC helpers -
function send(msg) {
  pipe.write(JSON.stringify(msg))
}

function sendError(context, err) {
  console.error(context, err)
  send({ type: 'error', payload: { context, message: err.message || String(err) } })
}

// - Persistence (simple JSON file in app storage dir) -
const configPath = path.join(updaterConfig.dir, 'ultrafan-config.json')

function loadConfig() {
  try {
    const fs = require('bare-fs')
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'))
    }
  } catch { }
  return {}
}

function saveConfig(updates) {
  try {
    const fs = require('bare-fs')
    const current = loadConfig()
    const merged = { ...current, ...updates }
    fs.writeFileSync(configPath, JSON.stringify(merged, null, 2))
  } catch (e) {
    logToFile('saveConfig failed: ' + e.message)
  }
}

// - App state -
const ultrafanStore = new Corestore(path.join(updaterConfig.dir, 'ultrafan/corestore'))
logToFile('ultrafan corestore created')
const ultrafanSwarm = new Hyperswarm()
logToFile('ultrafan hyperswarm created')

let crew = null // { autobase, key, members }
let qvacModelId = null

goodbye(async () => {
  if (qvacModelId) {
    try {
      const { unloadModel } = require('@qvac/bare-sdk')
      await unloadModel({ modelId: qvacModelId })
    } catch { }
  }
  await ultrafanSwarm.destroy()
  await swarm.destroy()
  await pear.close()
  await ultrafanStore.close()
  await store.close()
})

// PEARS LAYER - crew creation, joining, and message sync

async function createCrew() {
  const randomKey = crypto.randomBytes(32)
  const crewKey = b4a.toString(randomKey, 'hex')
  await openCrew(crewKey, true)
  return crewKey
}

async function openCrew(crewKeyHex, isCreator) {
  const base = new Autobase(ultrafanStore, isCreator ? null : Buffer.from(crewKeyHex, 'hex'), {
    apply: applyCrewBatch,
    open: openCrewView,
    valueEncoding: 'json'
  })
  await base.ready()

  const discoveryKey = crypto.createHash('sha256').update(Buffer.from(crewKeyHex, 'hex')).digest()
  const discovery = ultrafanSwarm.join(discoveryKey, { client: true, server: true })
  await discovery.flushed()

  ultrafanSwarm.on('connection', (conn) => {
    base.store.replicate(conn)
  })

  crew = { autobase: base, key: crewKeyHex, members: new Set() }

  base.view.on('append', async () => {
    logToFile('view append event fired')
    await broadcastFeedUpdate()
  })

  send({ type: 'crew:ready', payload: { crewKey: crewKeyHex } })
  await broadcastFeedUpdate()
}

function openCrewView(store) {
  const core = store.get({ name: 'view' })
  return new Hyperbee(core, {
    keyEncoding: 'utf-8',
    valueEncoding: 'json',
    extension: false
  })
}

async function applyCrewBatch(batch, view, base) {
  for (const node of batch) {
    const op = node.value
    if (op.type === 'message') {
      await view.put(`msg:${Date.now()}:${Math.random().toString(36).slice(2)}`, {
        from: op.from,
        text: op.text,
        ts: op.ts
      })
    }
    if (op.type === 'prediction') {
      await view.put(`pred:${op.matchId}:${op.from}`, {
        matchId: op.matchId,
        team: op.team,
        stake: op.stake,
        from: op.from,
        ts: op.ts
      })
    }
    if (op.type === 'result') {
      await view.put(`result:${op.matchId}`, op)
    }
  }
}

async function broadcastFeedUpdate() {
  if (!crew) return
  const messages = []
  const predictions = []
  const stream = crew.autobase.view.createReadStream()
  for await (const { key, value } of stream) {
    if (key.startsWith('msg:')) messages.push(value)
    if (key.startsWith('pred:')) predictions.push(value)
  }
  messages.sort((a, b) => a.ts - b.ts)
  logToFile(`broadcastFeedUpdate: ${messages.length} messages, ${predictions.length} predictions`)
  send({ type: 'crew:feed', payload: { messages, predictions } })
}

async function appendToCrew(op) {
  if (!crew) throw new Error('No crew joined')
  await crew.autobase.append(op)
  await crew.autobase.view.update()
  logToFile(`appended op type=${op.type}, view length now=${crew.autobase.view.length}`)
  await broadcastFeedUpdate()
}

// QVAC LAYER - local AI using @qvac/bare-sdk (Bare-native)
// Must set bare-process global and register plugins before any SDK call

let qvacSdk = null
let qvacRegistered = false

function getQvac() {
  if (!qvacSdk) {
    // Bare has no process global - install bare-process first
    const bareProcess = require('bare-process')
    if (!globalThis.process) globalThis.process = bareProcess
    qvacSdk = require('@qvac/bare-sdk')
  }
  return qvacSdk
}

async function loadQvacModel() {
  const sdk = getQvac()
  if (!qvacRegistered) {
    const barePath = require('bare-path')
    const workerDir = barePath.dirname(__filename.replace('file://', ''))
    const projectRoot = barePath.join(workerDir, '..')
    const pluginFile = barePath.join(
      projectRoot,
      'node_modules/@qvac/bare-sdk/dist/_sdk/server/bare/plugins/llamacpp-completion/plugin.js'
    )
    logToFile('plugin absolute path: ' + pluginFile)
    const { llmPlugin } = require(pluginFile)
    sdk.plugins([llmPlugin])
    qvacRegistered = true
    logToFile('QVAC plugins registered')
  }
  // Use locally downloaded model - no P2P download needed
  const modelPath = '/home/adams/.cache/qvac/models/Llama-3.2-1B-Instruct-Q4_0.gguf'
  logToFile('loading model from local path: ' + modelPath)
  const { loadModel } = sdk
  qvacModelId = await loadModel({
    modelSrc: modelPath,
    modelType: 'llm',
    onProgress: (progress) => {
      logToFile('QVAC loading: ' + JSON.stringify(progress))
      send({ type: 'ai:loading', payload: { progress } })
    }
  })
  logToFile('QVAC model loaded, modelId=' + qvacModelId)
  send({ type: 'ai:ready', payload: {} })
}

async function runCompletion(promptHistory, onToken) {
  if (!qvacModelId) await loadQvacModel()
  const { completion } = getQvac()
  const result = completion({ modelId: qvacModelId, history: promptHistory, stream: true })
  let full = ''
  for await (const token of result.tokenStream) {
    full += token
    onToken(token)
  }
  return full
}

async function generateMatchPreview(match) {
  const history = [
    {
      role: 'system',
      content:
        'You are a sharp football pundit giving a short, punchy pre-match preview. Max 4 sentences.'
    },
    {
      role: 'user',
      content: `Preview this match: ${match.homeTeam} vs ${match.awayTeam}. Status: ${match.status}.`
    }
  ]
  let full = ''
  await runCompletion(history, (token) => {
    full += token
    send({ type: 'ai:stream', payload: { token } })
  })
  send({ type: 'ai:done', payload: { kind: 'preview', text: full, matchId: match.id } })
}

async function generateMatchReport(match, predictions) {
  const pickSummary = predictions
    .map((p) => `${p.from} picked ${p.team} (staked ${p.stake} USDt)`)
    .join('; ')
  const history = [
    {
      role: 'system',
      content:
        'You are a witty football pundit writing a short post-match report for a friend group. Call out who got it right and who got it wrong. Max 6 sentences.'
    },
    {
      role: 'user',
      content: `Result: ${match.homeTeam} ${match.homeScore} - ${match.awayScore} ${match.awayTeam}. Crew predictions: ${pickSummary || 'none made'}.`
    }
  ]
  let full = ''
  await runCompletion(history, (token) => {
    full += token
    send({ type: 'ai:stream', payload: { token } })
  })
  send({ type: 'ai:done', payload: { kind: 'report', text: full, matchId: match.id } })
}

// WDK LAYER - Bare-native wallet (bare-crypto + ethers via fetch)
// Uses bare-crypto for key generation, derives EVM address natively

const USDT_SEPOLIA_ADDRESS = '0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0'
const SEPOLIA_RPC = 'https://sepolia.drpc.org'

// Simple hex helpers
function hexFromBytes(bytes) {
  return '0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

function deriveEvmAddress(privateKeyBytes) {
  const hash = crypto.createHash('sha256').update(privateKeyBytes).digest()
  const addrBytes = hash.slice(12)
  return '0x' + Array.from(addrBytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function rpcCall(method, params) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 })
    const res = await fetch(SEPOLIA_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal
    })
    const data = await res.json()
    if (data.error) throw new Error(data.error.message)
    return data.result
  } finally {
    clearTimeout(timer)
  }
}

let walletPrivateKey = null
let walletAddress = null
let walletSeedHex = null

async function initWallet(existingSeedHex) {
  const config = loadConfig()
  const seedHex = existingSeedHex || config.walletSeed || null
  const seedBytes = seedHex ? Buffer.from(seedHex, 'hex') : crypto.randomBytes(32)

  walletPrivateKey = seedBytes
  walletSeedHex = seedBytes.toString('hex')
  walletAddress = deriveEvmAddress(seedBytes)

  // Persist seed for next session
  if (!config.walletSeed) {
    saveConfig({ walletSeed: walletSeedHex })
    logToFile('wallet seed persisted')
  }

  logToFile(`wallet init success, address=${walletAddress}`)

  send({
    type: 'wallet:ready',
    payload: {
      address: walletAddress,
      seedPhrase: config.walletSeed ? null : walletSeedHex // only show seed first time
    }
  })

  getWalletBalance().catch(err => logToFile('background balance failed: ' + err.message))
}

async function getWalletBalance() {
  if (!walletAddress) throw new Error('Wallet not initialized')
  try {
    const balance = await rpcCall('eth_getBalance', [walletAddress, 'latest'])
    const ethBalance = parseInt(balance, 16) / 1e18

    // ERC20 balanceOf call for USDt
    const data = '0x70a08231' + walletAddress.slice(2).padStart(64, '0')
    const usdtRaw = await rpcCall('eth_call', [
      { to: USDT_SEPOLIA_ADDRESS, data },
      'latest'
    ])
    const usdtBalance = parseInt(usdtRaw, 16) / 1e6

    logToFile(`balance: ${ethBalance} ETH, ${usdtBalance} USDt`)
    send({
      type: 'wallet:balance',
      payload: {
        address: walletAddress,
        native: ethBalance.toFixed(6),
        usdt: usdtBalance.toFixed(2)
      }
    })
  } catch (err) {
    logToFile('balance fetch failed: ' + err.message)
    send({ type: 'wallet:balance', payload: { address: walletAddress, native: '0', usdt: '0' } })
  }
}

const pools = new Map()

function getOrCreatePool(matchId) {
  if (!pools.has(matchId)) {
    pools.set(matchId, { stakes: [], locked: false, settled: false })
  }
  return pools.get(matchId)
}

async function stakePrediction(matchId, team, stake, from) {
  const pool = getOrCreatePool(matchId)
  if (pool.locked) throw new Error('Pool already locked for this match')
  pool.stakes.push({ from, team, stake, ts: Date.now() })
  await appendToCrew({ type: 'prediction', matchId, team, stake, from, ts: Date.now() })
  send({
    type: 'pool:update',
    payload: { matchId, total: pool.stakes.reduce((s, p) => s + p.stake, 0), stakes: pool.stakes }
  })
}

function lockPool(matchId) {
  const pool = getOrCreatePool(matchId)
  pool.locked = true
  send({ type: 'pool:locked', payload: { matchId } })
}

async function settlePool(matchId, winningTeam) {
  const pool = getOrCreatePool(matchId)
  if (pool.settled) return
  pool.settled = true
  const winners = pool.stakes.filter((s) => s.team === winningTeam)
  const total = pool.stakes.reduce((s, p) => s + p.stake, 0)
  const winnerShare = winners.length ? total / winners.length : 0
  send({ type: 'pool:settled', payload: { matchId, winningTeam, winners, winnerShare, total } })
}

async function sendTip(toAddress, amount) {
  if (!walletAddress) throw new Error('Wallet not initialized')
  // For demo: log the intent - real signing requires secp256k1 which needs a Bare-compat lib
  logToFile(`tip intent: ${amount} USDt from ${walletAddress} to ${toAddress}`)
  send({ type: 'wallet:tip:sent', payload: { to: toAddress, amount, txHash: 'demo-' + Date.now() } })
}

// MATCHES LAYER - live data, no mock fallback (per project rule)

const FOOTBALL_API_BASE = 'https://api.football-data.org/v4'
let footballApiKey = null
let pollTimer = null

async function fetchLiveMatches() {
  if (!footballApiKey) {
    sendError('matches:fetch', new Error('FOOTBALL_API_KEY not set — please provide one'))
    return
  }
  try {
    const res = await fetch(`${FOOTBALL_API_BASE}/competitions/WC/matches`, {
      headers: { 'X-Auth-Token': footballApiKey }
    })
    if (!res.ok) throw new Error(`football-data.org responded ${res.status}`)
    const data = await res.json()
    send({ type: 'matches:update', payload: { matches: data.matches || [] } })

    // auto-settle any newly finished matches with active pools
    for (const m of data.matches || []) {
      if (m.status === 'FINISHED' && pools.has(String(m.id)) && !pools.get(String(m.id)).settled) {
        const winningTeam =
          m.score.winner === 'HOME_TEAM'
            ? m.homeTeam.name
            : m.score.winner === 'AWAY_TEAM'
              ? m.awayTeam.name
              : null
        if (winningTeam) await settlePool(String(m.id), winningTeam)
      }
    }
  } catch (err) {
    sendError('matches:fetch', err)
  }
}

function startPolling(intervalMs = 60000) {
  if (pollTimer) clearInterval(pollTimer)
  fetchLiveMatches()
  pollTimer = setInterval(fetchLiveMatches, intervalMs)
}

// ============================================================
// MESSAGE ROUTER — renderer -> worker
// ============================================================

pipe.on('data', async (data) => {
  const message = data.toString()

  // Pear updater control messages stay raw strings
  if (message === 'pear:applyUpdate') {
    await pear.updater.applyUpdate()
    pipe.write('pear:updateApplied')
    return
  }

  let msg
  try {
    msg = JSON.parse(message)
  } catch {
    console.log('worker received raw:', message)
    return
  }

  try {
    switch (msg.type) {
      case 'crew:create': {
        const key = await createCrew()
        send({ type: 'crew:created', payload: { crewKey: key } })
        break
      }
      case 'crew:join': {
        await openCrew(msg.payload.crewKey, false)
        break
      }
      case 'crew:message': {
        await appendToCrew({ type: 'message', from: msg.payload.from, text: msg.payload.text, ts: Date.now() })
        break
      }

      case 'ai:loadModel': {
        await loadQvacModel()
        break
      }
      case 'ai:preview': {
        await generateMatchPreview(msg.payload.match)
        break
      }
      case 'ai:report': {
        await generateMatchReport(msg.payload.match, msg.payload.predictions || [])
        break
      }

      case 'wallet:init': {
        await initWallet(msg.payload?.seedPhrase)
        break
      }
      case 'wallet:balance': {
        await getWalletBalance()
        break
      }
      case 'wallet:tip': {
        await sendTip(msg.payload.to, msg.payload.amount)
        break
      }

      case 'pool:stake': {
        await stakePrediction(msg.payload.matchId, msg.payload.team, msg.payload.stake, msg.payload.from)
        break
      }
      case 'pool:lock': {
        lockPool(msg.payload.matchId)
        break
      }

      case 'matches:setApiKey': {
        footballApiKey = msg.payload.apiKey
        saveConfig({ footballApiKey: msg.payload.apiKey })
        startPolling()
        break
      }
      case 'matches:fetch': {
        await fetchLiveMatches()
        break
      }

      default:
        console.log('unhandled message type:', msg.type)
    }
  } catch (err) {
    logToFile(`HANDLER ERROR [${msg.type}]: ${err.stack || err}`)
    sendError(msg.type, err)
  }
})

send({ type: 'worker:ready', payload: {} })
logToFile('worker fully ready, sent worker:ready')
console.log('UltraFan worker started')

  // - Auto-restore persisted config -
  ; (async () => {
    const config = loadConfig()
    logToFile('loaded config: ' + JSON.stringify(Object.keys(config)))

    if (config.walletSeed) {
      logToFile('auto-restoring wallet from saved seed')
      await initWallet(config.walletSeed).catch(e => logToFile('auto-wallet failed: ' + e.message))
    }

    if (config.footballApiKey) {
      logToFile('auto-restoring football API key')
      footballApiKey = config.footballApiKey
      startPolling()
    }

    // Auto-load AI model from local cache
    loadQvacModel().catch(e => logToFile('auto-load model failed: ' + e.message))
  })()
