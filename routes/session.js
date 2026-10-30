import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import * as gov from '../governor.js'

const MAX_SESSIONS = 50

export function sessionRouter({ FARM, clients, connect, emit, blockedOf, markUnblocked }) {
  const r = express.Router()

  // empêche toute sortie du dossier sessions/
  const safe = dir => {
    const p = path.resolve(FARM, dir)
    return p.startsWith(path.resolve(FARM)) && fs.existsSync(p) ? p : null
  }

  const info = d => {
    const key = FARM + '/' + d
    const c = clients.get(key)
    let fp = null
    try { fp = JSON.parse(fs.readFileSync(key + '/fp.json', 'utf8')) } catch {}
    const g = gov.snap().find(x => x.dir === key)
    return {
      dir: d,
      ready: !!c?.ready,
      jid: c?.jid || null,
      code: c?.code || null,
      qr: c?.qr || null,
      paused: !!g?.paused,
      reason: g?.reason || null,
      sentToday: g?.count || 0,
      blocked: Object.keys(blockedOf(key)).length,
      fingerprint: fp ? fp.join(' / ') : null,
      pairedAt: c?.pairedAt || null
    }
  }

  /* liste */
  r.get('/', (req, res) => {
    const dirs = fs.readdirSync(FARM).filter(d => fs.statSync(FARM + '/' + d).isDirectory())
    res.json(dirs.map(info))
  })

  /* agrégat */
  r.get('/stats', (req, res) => {
    const all = fs.readdirSync(FARM)
      .filter(d => fs.statSync(FARM + '/' + d).isDirectory())
      .map(info)
    res.json({
      total: all.length,
      max: MAX_SESSIONS,
      ready: all.filter(s => s.ready).length,
      paused: all.filter(s => s.paused).length,
      blockedTotal: all.reduce((n, s) => n + s.blocked, 0),
      saturated: all.filter(s => s.sentToday >= gov.CAPS.msgsPerSessionPerDay).length
    })
  })

  /* détail */
  r.get('/:dir', (req, res) => {
    const p = safe(req.params.dir)
    if (!p) return res.status(404).json({ error: 'inconnue' })
    res.json({ ...info(req.params.dir), blockedList: Object.entries(blockedOf(FARM + '/' + req.params.dir)) })
  })

  /* création */
  r.post('/', async (req, res) => {
    const existing = fs.readdirSync(FARM).filter(d => fs.statSync(FARM + '/' + d).isDirectory()).length
    const asked = Math.min(Math.max(parseInt(req.body?.count) || 1, 1), 10)
    const room = Math.max(0, MAX_SESSIONS - existing)
    if (!room) return res.status(409).json({ error: 'plafond de ' + MAX_SESSIONS + ' sessions atteint' })

    const count = Math.min(asked, room)
    const number = req.body?.number ? String(req.body.number).replace(/\D/g, '') : null
    const out = []

    for (let i = 0; i < count; i++) {
      const dir = FARM + '/s' + Date.now() + '_' + i
      try {
        const rec = await connect(dir, number ? { pairingNumber: number } : {})
        out.push({ dir, code: rec.code, qr: rec.qr })
      } catch (e) {
        emit('err', 'création ' + dir + ' : ' + e.message)
        out.push({ dir, error: e.message })
      }
    }
    res.json({ created: out.length, sessions: out })
  })

  /* réactivation après pause du governor */
  r.post('/:dir/resume', (req, res) => {
    const d = req.params.dir
    if (!safe(d)) return res.status(404).json({ error: 'inconnue' })
    gov.resume(FARM + '/' + d)
    emit('dim', d + ' : réactivée manuellement')
    res.json({ ok: true })
  })

  /* purge des blocages : débloque tout ce que la session retient */
  r.post('/:dir/unblock', async (req, res) => {
    const d = req.params.dir
    if (!safe(d)) return res.status(404).json({ error: 'inconnue' })
    const key = FARM + '/' + d
    const rec = clients.get(key)
    if (!rec?.ready) return res.status(409).json({ error: 'session non connectée' })

    const targets = Object.keys(blockedOf(key))
    let ok = 0, ko = 0
    for (const jid of targets) {
      try {
        await rec.sock.updateBlockStatus(jid, 'unblock')
        markUnblocked(key, jid)
        ok++
      } catch { ko++ }
      await new Promise(r2 => setTimeout(r2, 600))
    }
    emit(ko ? 'warn' : 'ok', d + ' : purge blocages ' + ok + ' ok, ' + ko + ' échecs')
    res.json({ ok, ko })
  })

  /* suppression */
  r.delete('/:dir', async (req, res) => {
    const d = req.params.dir
    const p = safe(d)
    if (!p) return res.status(404).json({ error: 'inconnue' })
    const key = FARM + '/' + d
    try { await clients.get(key)?.sock.logout() } catch {}
    clients.delete(key)
    gov.resume(key)
    fs.rmSync(p, { recursive: true, force: true })
    emit('dim', d + ' : supprimée')
    res.json({ ok: true })
  })

  return r
      }
