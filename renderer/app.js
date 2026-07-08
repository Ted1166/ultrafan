// Talks to workers/main.js via window.bridge (contextBridge from preload.js)
// All messages are JSON strings over the FramedStream IPC pipe.

const bridge = window.bridge
const decoder = new TextDecoder('utf-8')
const encoder = new TextEncoder()

const WORKER = '/workers/main.js'

let myName = 'You'
let myAddress = null
let aiReady = false
let walletReady = false
let crewReady = false
let currentMatch = null
let liveMatches = []
let crewMessages = []
let crewPredictions = []

// - Worker IPC plumbing -

function sendToWorker(type, payload = {}) {
  const json = JSON.stringify({ type, payload })
  bridge.writeWorkerIPC(WORKER, encoder.encode(json))
}

function setupWorkerListeners() {
  bridge.onWorkerIPC(WORKER, (data) => {
    const raw = decoder.decode(data)
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      // raw pear updater strings ('updating', 'updated', etc) - ignore here
      return
    }
    handleWorkerMessage(msg)
  })

  bridge.onWorkerStdout(WORKER, (data) => {
    console.log('[worker stdout]', decoder.decode(data))
  })

  bridge.onWorkerStderr(WORKER, (data) => {
    const msg = decoder.decode(data)
    // Suppress llama.cpp verbose repacking noise — not actionable errors
    if (msg.includes('repack:') || msg.includes('ggml_vulkan') ||
      msg.includes('no usable GPU') || msg.includes('gpu-layers') ||
      msg.includes('llama.cpp was compiled') || msg.includes('initFromConfig') ||
      msg.includes('common_init_result') || msg.includes('parse: load') ||
      msg.includes('build.md')) return
    console.error('[worker stderr]', msg)
  })

  bridge.onWorkerExit(WORKER, (code) => {
    console.error('Worker exited with code', code)
    setPulse('crew', false, 'Worker crashed')
  })
}

function handleWorkerMessage(msg) {
  switch (msg.type) {
    case 'worker:ready':
      console.log('worker ready')
      break

    case 'crew:created':
    case 'crew:ready': {
      crewReady = true
      const key = msg.payload.crewKey
      setPulse('crew', true, 'Crew live')
      enterCrewView(key)
      break
    }

    case 'crew:feed': {
      crewMessages = msg.payload.messages || []
      crewPredictions = msg.payload.predictions || []
      renderFeed()
      renderPool()
      break
    }

    case 'ai:loading': {
      const pct = msg.payload.progress?.percent ?? msg.payload.progress
      setPulse('ai', false, `Loading AI ${pct ? Math.round(pct) + '%' : '...'}`)
      break
    }

    case 'ai:ready': {
      aiReady = true
      setPulse('ai', true, 'AI ready')
      break
    }

    case 'ai:stream': {
      appendStreamToken(msg.payload.token)
      break
    }

    case 'ai:done': {
      finalizeAIMessage(msg.payload)
      break
    }

    case 'wallet:ready': {
      walletReady = true
      myAddress = msg.payload.address
      setPulse('wallet', true, shortAddr(myAddress))
      // Reset any "Creating..." buttons regardless of which screen we're on
      const btn1 = document.getElementById('btn-init-wallet')
      if (btn1) { btn1.disabled = false; btn1.textContent = 'Wallet ready ✓' }
      const btn2 = document.getElementById('btn-init-wallet-2')
      if (btn2) { btn2.disabled = false; btn2.textContent = 'Wallet ready ✓' }
      // Render wallet card if crew view is active
      renderWalletCard(msg.payload.seedPhrase)
      // Request balance (non-blocking, may fail silently)
      sendToWorker('wallet:balance')
      break
    }

    case 'wallet:balance': {
      renderBalance(msg.payload)
      break
    }

    case 'wallet:tip:sent': {
      flashToast(`Tip sent: ${msg.payload.amount} to ${shortAddr(msg.payload.to)}`)
      break
    }

    case 'matches:update': {
      liveMatches = msg.payload.matches || []
      renderMatches()
      break
    }

    case 'pool:update':
    case 'pool:locked':
    case 'pool:settled': {
      renderPool()
      if (msg.type === 'pool:settled') {
        flashToast(
          `${msg.payload.winningTeam} won the pool — ${msg.payload.winnerShare.toFixed(2)} USDt each to ${msg.payload.winners.length} winner(s)`
        )
      }
      break
    }

    case 'error': {
      console.error('worker error:', msg.payload)
      flashToast(`Error: ${msg.payload.message}`, true)
      break
    }

    default:
      console.log('unhandled worker message', msg)
  }
}

// - Pulse bar -

function setPulse(segment, live, label) {
  const el = document.getElementById(`pulse-${segment}`)
  if (!el) return
  el.classList.toggle('live', live)
  el.querySelector('.pulse-dot').nextSibling.textContent = label
}

// - Onboarding -

document.getElementById('btn-create-crew').addEventListener('click', () => {
  sendToWorker('crew:create')
})

document.getElementById('btn-show-join').addEventListener('click', () => {
  document.getElementById('join-input').style.display = 'block'
  document.getElementById('btn-join-crew').style.display = 'inline-block'
})

document.getElementById('btn-join-crew').addEventListener('click', () => {
  const key = document.getElementById('join-input').value.trim()
  if (!key) return
  sendToWorker('crew:join', { crewKey: key })
})

document.getElementById('btn-load-ai').addEventListener('click', (e) => {
  e.target.disabled = true
  e.target.textContent = 'Loading...'
  sendToWorker('ai:loadModel')
})

document.getElementById('btn-init-wallet').addEventListener('click', (e) => {
  e.target.disabled = true
  e.target.textContent = 'Creating...'
  sendToWorker('wallet:init')
})

document.getElementById('btn-set-api-key').addEventListener('click', () => {
  const key = document.getElementById('api-key-input').value.trim()
  if (!key) return
  sendToWorker('matches:setApiKey', { apiKey: key })
  document.getElementById('btn-set-api-key').textContent = 'Connected'
  document.getElementById('btn-set-api-key').disabled = true
})

// - Crew view (replaces onboarding once crew is ready) -

function enterCrewView(crewKey) {
  const crewCol = document.getElementById('crew-col')
  crewCol.innerHTML = `
    <div class="col-header">
      <div class="col-eyebrow">Crew key — share to invite</div>
      <div class="col-title" id="crew-key-display" style="font-size:13px; font-family:monospace; cursor:pointer; color: var(--lime);" title="Click to copy">${crewKey}</div>
    </div>
    <div id="feed-scroll"></div>
    <div id="composer">
      <input id="msg-input" placeholder="Message your crew..." />
      <button class="btn btn-primary" id="btn-send">Send</button>
    </div>
  `

  document.getElementById('crew-key-display').addEventListener('click', () => {
    navigator.clipboard?.writeText(crewKey)
    flashToast('Crew key copied')
  })

  document.getElementById('btn-send').addEventListener('click', sendMessage)
  document.getElementById('msg-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMessage()
  })

  enterContextView()
}

function sendMessage() {
  const input = document.getElementById('msg-input')
  const text = input.value.trim()
  if (!text) return
  sendToWorker('crew:message', { from: myName, text })
  input.value = ''
}

function renderFeed() {
  const scroll = document.getElementById('feed-scroll')
  if (!scroll) return
  scroll.innerHTML = crewMessages
    .map(
      (m) => `
    <div class="msg">
      <div class="msg-avatar">${initials(m.from)}</div>
      <div class="msg-body">
        <div class="msg-from">${escapeHtml(m.from)}</div>
        ${escapeHtml(m.text)}
      </div>
    </div>
  `
    )
    .join('')
  scroll.scrollTop = scroll.scrollHeight
}

let streamingMsgEl = null
function appendStreamToken(token) {
  if (!streamingMsgEl) {
    const scroll = document.getElementById('feed-scroll')
    const wrap = document.createElement('div')
    wrap.className = 'msg msg-ai'
    wrap.innerHTML = `
      <div class="msg-avatar">AI</div>
      <div class="msg-body"><div class="msg-from">Match AI</div><span class="stream-text"></span></div>
    `
    scroll.appendChild(wrap)
    streamingMsgEl = wrap.querySelector('.stream-text')
    scroll.scrollTop = scroll.scrollHeight
  }
  streamingMsgEl.textContent += token
}

function finalizeAIMessage() {
  streamingMsgEl = null
}

// - Context column (AI / wallet / matches / pool) -

function enterContextView() {
  const ctx = document.getElementById('context-col')
  ctx.innerHTML = `
    <div class="col-header">
      <div class="col-eyebrow">Match center</div>
      <div class="col-title">UltraFan</div>
    </div>
    <div id="context-scroll">
      <div class="card" id="wallet-card">
        <div class="card-label">Wallet</div>
        <p style="font-size:13px;color:var(--sage);">${walletReady ? '' : 'Restoring wallet...'}</p>
        ${walletReady ? '' : '<button class="btn btn-coral" id="btn-init-wallet-2" style="width:100%;margin-top:8px;">Create new wallet</button>'}
      </div>
      <div class="card" id="ai-card">
        <div class="card-label">Local AI</div>
        <p style="font-size:13px;color:var(--sage);">${aiReady ? 'Model ready.' : 'Loading model...'}</p>
        ${aiReady ? '' : '<button class="btn btn-primary" id="btn-load-ai-2" style="width:100%;margin-top:8px;display:none;">Load AI model</button>'}
      </div>
      <div class="card" id="matches-card">
        <div class="card-label">Live matches</div>
        <input id="api-key-input-2" placeholder="football-data.org API key (saved automatically)" style="width:100%;background:var(--turf-light);border:1px solid var(--line);color:var(--chalk);padding:10px;border-radius:6px;font-size:12px;margin-bottom:8px;" />
        <button class="btn btn-secondary" id="btn-set-api-key-2" style="width:100%;">Connect live scores</button>
        <div id="matches-list" style="margin-top:10px;"></div>
      </div>
      <div class="card" id="pool-card" style="display:none;">
        <div class="card-label">Prediction pool</div>
        <div id="pool-body"></div>
      </div>
    </div>
  `

  const btn2 = document.getElementById('btn-init-wallet-2')
  if (btn2) btn2.addEventListener('click', (e) => {
    e.target.disabled = true
    e.target.textContent = 'Creating...'
    sendToWorker('wallet:init')
  })
  const btnAi2 = document.getElementById('btn-load-ai-2')
  if (btnAi2) btnAi2.addEventListener('click', (e) => {
    e.target.disabled = true
    e.target.textContent = 'Loading...'
    sendToWorker('ai:loadModel')
  })
  document.getElementById('btn-set-api-key-2').addEventListener('click', () => {
    const key = document.getElementById('api-key-input-2').value.trim()
    if (!key) return
    sendToWorker('matches:setApiKey', { apiKey: key })
    document.getElementById('btn-set-api-key-2').textContent = 'Connected'
    document.getElementById('btn-set-api-key-2').disabled = true
  })
}

function renderWalletCard(seedPhrase) {
  const card = document.getElementById('wallet-card')
  if (!card) return
  card.innerHTML = `
    <div class="card-label">Wallet</div>
    <div class="wallet-balance" id="wallet-balance-display">— USDt</div>
    <div class="wallet-addr">${myAddress}</div>
    ${seedPhrase ? `<div style="margin-top:10px;padding:10px;background:rgba(255,107,74,0.08);border:1px solid var(--coral);border-radius:6px;font-size:11px;color:var(--coral);"><strong>Save your seed phrase:</strong><br/><span style="font-family:monospace;">${seedPhrase}</span></div>` : ''}
  `
}

function renderBalance(payload) {
  const el = document.getElementById('wallet-balance-display')
  if (el) el.textContent = `${parseFloat(payload.usdt || 0).toFixed(2)} USDt`
}

function renderMatches() {
  const list = document.getElementById('matches-list')
  if (!list) return
  if (!liveMatches.length) {
    list.innerHTML = `<p style="font-size:12px;color:var(--sage);">No matches loaded yet.</p>`
    return
  }
  list.innerHTML = liveMatches
    .slice(0, 8)
    .map(
      (m) => `
    <div class="card" style="margin-bottom:8px;cursor:pointer;" data-match-id="${m.id}">
      <div class="match-teams">${escapeHtml(m.homeTeam.name)} vs ${escapeHtml(m.awayTeam.name)}</div>
      <div class="match-status">${m.status}${m.status === 'FINISHED' ? ` · ${m.score.fullTime.home}-${m.score.fullTime.away}` : ''}</div>
    </div>
  `
    )
    .join('')

  list.querySelectorAll('[data-match-id]').forEach((card) => {
    card.addEventListener('click', () => selectMatch(card.dataset.matchId))
  })
}

function selectMatch(matchId) {
  const match = liveMatches.find((m) => String(m.id) === String(matchId))
  if (!match) return
  currentMatch = {
    id: String(match.id),
    homeTeam: match.homeTeam.name,
    awayTeam: match.awayTeam.name,
    status: match.status,
    homeScore: match.score?.fullTime?.home,
    awayScore: match.score?.fullTime?.away
  }

  if (aiReady) {
    sendToWorker('ai:preview', { match: currentMatch })
  }

  document.getElementById('pool-card').style.display = 'block'
  renderPool()
}

function renderPool() {
  const body = document.getElementById('pool-body')
  if (!body || !currentMatch) return

  const stakesForMatch = crewPredictions.filter((p) => String(p.matchId) === String(currentMatch.id))
  const total = stakesForMatch.reduce((s, p) => s + Number(p.stake || 0), 0)

  body.innerHTML = `
    <div style="font-size:12px;color:var(--sage);margin-bottom:8px;">${currentMatch.homeTeam} vs ${currentMatch.awayTeam}</div>
    ${stakesForMatch.map((p) => `<div class="pool-row"><span>${escapeHtml(p.from)} → ${escapeHtml(p.team)}</span><span>${p.stake} USDt</span></div>`).join('')}
    <div class="pool-row" style="font-weight:700;"><span>Total pool</span><span>${total} USDt</span></div>
    <div class="stake-controls">
      <select id="stake-team" style="background:var(--turf-light);border:1px solid var(--line);color:var(--chalk);padding:8px;border-radius:6px;font-size:13px;">
        <option value="${currentMatch.homeTeam}">${currentMatch.homeTeam}</option>
        <option value="${currentMatch.awayTeam}">${currentMatch.awayTeam}</option>
      </select>
      <input type="number" id="stake-amount" placeholder="USDt" min="1" />
      <button class="btn btn-coral" id="btn-stake">Stake</button>
    </div>
  `

  document.getElementById('btn-stake')?.addEventListener('click', () => {
    const team = document.getElementById('stake-team').value
    const amount = parseFloat(document.getElementById('stake-amount').value)
    if (!amount || amount <= 0) return
    sendToWorker('pool:stake', { matchId: currentMatch.id, team, stake: amount, from: myName })
  })
}

// - Utilities -

function initials(name) {
  return (name || '?').slice(0, 2).toUpperCase()
}

function shortAddr(addr) {
  if (!addr) return ''
  return addr.slice(0, 6) + '…' + addr.slice(-4)
}

function escapeHtml(str) {
  const div = document.createElement('div')
  div.textContent = str ?? ''
  return div.innerHTML
}

let toastTimer = null
function flashToast(message, isError = false) {
  let toast = document.getElementById('toast')
  if (!toast) {
    toast = document.createElement('div')
    toast.id = 'toast'
    toast.style.cssText = `
      position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
      background: var(--turf); border: 1px solid var(--lime); color: var(--chalk);
      padding: 12px 20px; border-radius: 8px; font-size: 13px; z-index: 999;
      box-shadow: 0 4px 20px rgba(0,0,0,0.4);
    `
    document.body.appendChild(toast)
  }
  toast.style.borderColor = isError ? 'var(--coral)' : 'var(--lime)'
  toast.textContent = message
  toast.style.display = 'block'
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.style.display = 'none'
  }, 4000)
}

// - Boot -

setupWorkerListeners()
bridge.startWorker(WORKER)
console.log('UltraFan renderer started, pkg version:', bridge.pkg().version)
