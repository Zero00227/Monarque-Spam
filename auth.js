import { initAuthCreds } from '@whiskeysockets/baileys'

export function memAuth() {
  const creds = initAuthCreds(); const store = new Map()
  return {
    state: {
      creds,
      keys: {
        get: async (t, ids) => Object.fromEntries(ids.filter(i => store.has(t + i)).map(i => [i, store.get(t + i)])),
        set: async d => { for (const t in d) for (const i in d[t]) d[t][i] ? store.set(t + i, d[t][i]) : store.delete(t + i) }
      }
    }
  }
}
