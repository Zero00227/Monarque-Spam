import { makeWASocket, delay } from '@whiskeysockets/baileys'
import { memAuth } from './auth.js'
import pino from 'pino'

const logger = pino({ level: 'silent' })
const samples = []
let baseline = { exists: null, latencies: [] }
let running = false, timer = null, cursor = 0, consecutiveMiss = 0
let witnesses = [], emit = () => {}, onVerdict = () => {}

export const setEmit = f => (emit = f)
export const setWitnesses = l => (witnesses = l)
export const setOnVerdict = f => (onVerdict = f)
export const baselineOf = () => baseline
export const isRunning = () => running

/* --- check d'existence : socket jetable, zéro compte --- */
export function existsCheck(number) {
  const { state } = memAuth()
  const sock = makeWASocket({ auth: state, logger, printQRInTerminal: false })
  return new Promise(resolve => {
    let settled = false
    const done = r => { if (settled) return; settled = true; try { sock.end(undefined) } catch {} ; resolve(r) }
    const t = setTimeout(() => done({ exists: null, err: 'timeout' }), 12000)
    sock.ev.on('connection.update', async u => {
      if (u.connection !== 'open') return
      try {
        const [r] = await sock.onWhatsApp(number)
        clearTimeout(t); done({ exists: !!r?.exists })
      } catch (e) { clearTimeout(t); done({ exists: null, err: e.message }) }
    })
  })
}

/* --- sonde de livraison via un témoin --- */
export function deliverProbe(rec, jid) {
  const sock = rec.sock
  const id = 'PRB' + Date.now() + Math.random().toString(36).slice(2, 6)
  const t0 = Date.now()
  return new Promise(resolve => {
    let settled = false
    const h = ups => {
      for (const u of ups) if (u.key?.id === id) {
        const ty = u.receipt?.type
        if (ty === 'delivery' || ty === 'read' || ty === 'played') finish({ ack: true, ms: Date.now() - t0 })
      }
    }
    const finish = v => {
      if (settled) return
      settled = true; sock.ev.off('message-receipt.update', h)
      clearTimeout(to); resolve(v)
    }
    const to = setTimeout(() => finish({ ack: false }), 15000)
    sock.ev.on('message-receipt.update', h)
    sock.sendMessage(jid, { text: `· sonde ${new Date().toISOString().slice(11, 19)} ·` }, { messageId: id })
      .catch(e => finish({ ack: false, err: e.message }))
  })
}

const med = a => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0 }

export function score() {
  const win = samples.slice(-20)
  if (!win.length) return { score: 0, verdict: 'OK' }
  let s = 0
  if (baseline.exists === true && win.some(x => x.exists === false)) s += 55
  const missed = win.filter(x => x.ack === false).length
  s += Math.min(25, missed * 5)
  const lats = win.filter(x => x.ack).map(x => x.ms)
  if (lats.length && baseline.latencies.length) {
    const drift = med(lats) - med(baseline.latencies)
    if (drift > 2000) s += Math.min(20, Math.round(drift / 400))
  }
  if (consecutiveMiss >= 3) s += 15
  s = Math.min(100, s)
  const verdict = s >= 75 ? 'BANNI' : s >= 45 ? 'SHADOWBAN' : s >= 20 ? 'SUSPECT' : 'OK'
  return { score: s, verdict }
}

export const state = () => ({
  running,
  baseline,
  samples: samples.slice(-60),
  ...score(),
  mode: witnesses.length ? 'ack' : 'exists-only'
})

async function tick(jid) {
  const number = jid.split('@')[0]
  const s = { t: Date.now(), exists: null, ack: null, ms: null }

  // l'existence est vérifiée 1 tick sur 3 (coût réseau)
  if (samples.length % 3 === 0 || !witnesses.length) {
    const e = await existsCheck(number)
    s.exists = e.exists
    if (baseline.exists === true && e.exists === false) emit({ level: 'err', text: 'exists → false (disparition du check)' })
  }

  if (witnesses.length) {
    const w = witnesses[cursor++ % witnesses.length]
    const r = await deliverProbe(w, jid)
    s.ack = r.ack; s.ms = r.ms ?? null
    consecutiveMiss = r.ack ? 0 : consecutiveMiss + 1
    emit({ level: r.ack ? 'dim' : 'warn', text: `sonde ${w.dir} → ${r.ack ? r.ms + ' ms' : 'ack manqué'}` })
  }

  samples.push(s)
  if (samples.length > 300) samples.shift()

  const v = score()
  emit({ level: v.verdict === 'OK' ? 'dim' : 'hi', text: `verdict ${v.verdict} (${v.score})` })
  onVerdict(v, s)
  if (v.verdict === 'BANNI') { stop(); emit({ level: 'err', text: 'cible bannie — sonde arrêtée' }) }
}

export async function start(jid, intervalMs = 60000) {
  if (running) return { error: 'sonde déjà active' }
  running = true; samples.length = 0; consecutiveMiss = 0; cursor = 0
  baseline = { exists: null, latencies: [] }

  emit({ level: 'hi', text: `sonde démarrée (${witnesses.length ? 'acks + exists' : 'exists seul'})` })
  const e0 = await existsCheck(jid.split('@')[0])
  baseline.exists = e0.exists
  emit({ level: 'dim', text: `baseline exists=${e0.exists}` })

  for (let i = 0; i < 3 && witnesses.length; i++) {
    const w = witnesses[cursor++ % witnesses.length]
    const r = await deliverProbe(w, jid)
    if (r.ack) baseline.latencies.push(r.ms)
    await delay(2500)
  }
  if (baseline.latencies.length) emit({ level: 'dim', text: `baseline latence médiane ${med(baseline.latencies)} ms` })

  tick(jid)
  timer = setInterval(() => tick(jid), intervalMs)
  return { ok: true }
}

export function stop() {
  running = false
  if (timer) clearInterval(timer)
  timer = null
        }
