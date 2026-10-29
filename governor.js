// Empêche toute session de sortir de l'enveloppe d'un usage humain.
const DAY = 86400000

export const CAPS = {
  msgsPerSessionPerCycle: 1,   // une seule cible par session par passage
  msgsPerSessionPerDay: 15,    // très en dessous des limites réelles
  jitter: [3000, 9000],        // jamais deux envois au même rythme
  minAgeForGroup: 7 * DAY,     // pas de création de groupe sur un compte neuf
  pauseOn: [401, 403, 429, 500]
}

const state = new Map() // dir -> { count, day, paused, reason }

const today = () => Math.floor(Date.now() / DAY)

export function touch(dir) {
  const s = state.get(dir) || { count: 0, day: today(), paused: false, reason: null }
  if (s.day !== today()) { s.count = 0; s.day = today() }
  state.set(dir, s)
  return s
}

export function canSend(dir) {
  const s = touch(dir)
  if (s.paused) return { ok: false, why: s.reason }
  if (s.count >= CAPS.msgsPerSessionPerDay)
    return { ok: false, why: `plafond ${CAPS.msgsPerSessionPerDay}/j atteint` }
  return { ok: true }
}

export function record(dir) { touch(dir).count++ }

export function pause(dir, reason) {
  const s = touch(dir); s.paused = true; s.reason = reason
}

export function resume(dir) { const s = touch(dir); s.paused = false; s.reason = null }

export function isPaused(dir) { return !!state.get(dir)?.paused }

export const snap = () => [...state.entries()].map(([dir, s]) => ({ dir, ...s }))

// délais humanisés : jamais un timing constant
export const humanDelay = () => {
  const [a, b] = CAPS.jitter
  return Math.floor(Math.random() * (b - a) + a)
}
export const typingTime = len => Math.min(6000, 700 + len * 45)
