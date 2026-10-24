/**
 * Offline acceptance test for the host half of dsh-account-glance.
 *
 * The host modules are the shipped artifact, so this test executes THOSE files
 * against stand-ins for the cordis context, the host fetch and the HTTP
 * request/response objects. It proves, without a running DSH:
 *
 *  1. the DeepSeek peak / off-peak clock and price book (the card's second line
 *     and the ledger's cost column);
 *  2. the ledger fold, day bucketing in Beijing time, retention pruning and
 *     untrusted-JSON revival;
 *  3. the credential resolution order and the balance probe (headers, parse,
 *     failure shapes, the foreign-origin guard);
 *  4. the service: session-event folding, the overview document, persistence
 *     across a restart, and the route trust fence (200 / 403 / 405);
 *  5. the host entry point registers exactly two routes and unregisters them on
 *     dispose.
 *
 * Run with the DSH runtime's Node: `node test/host-verify.mjs`.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Every await in this test resolves in the microtask queue, so the event loop's
 * timer and I/O phases never run on their own. Real file I/O (the persisted
 * ledger read) therefore needs an explicit yield.
 */
const realSetTimeout = globalThis.setTimeout
const settleIo = () => new Promise((resolve) => realSetTimeout(resolve, 20))

/* A throwaway DSH home keeps the ledger writes out of the real one. */
const DSH_HOME = mkdtempSync(join(tmpdir(), 'dsag-host-verify-'))
process.env.DSH_HOME = DSH_HOME

const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)
const { AccountGlanceService } = await import(new URL('../lib/host/service.js', import.meta.url).href)
const { beijingDateKey, deepseekModelSpend, deepseekPeriodAt, isDeepSeekRoute, isPublicHoliday } = await import(new URL('../lib/host/pricing.js', import.meta.url).href)
const { createLedgerDocument, deserializeLedger, emptyTotals, foldUsage, pruneLedger, summarizeDays, totalTokens } = await import(new URL('../lib/host/ledger.js', import.meta.url).href)
const { balanceAppliesToRoute, listDeepSeekRoutes, probeBalance, resolveCredential, routeBaseUrl } = await import(new URL('../lib/host/probe.js', import.meta.url).href)
const { makeOverviewRoute, makeRefreshRoute } = await import(new URL('../lib/host/routes.js', import.meta.url).href)

const realNow = Date.now
const realFetch = globalThis.fetch

/* ------------------------------------------------------------------ *
 * Stand-ins
 * ------------------------------------------------------------------ */

/** A minimal cordis context: service lookup, event bus, effects, webserver. */
function makeCtx(services = {}) {
  const listeners = new Map()
  const routes = []
  const disposers = []
  return {
    get(name) {
      return Object.prototype.hasOwnProperty.call(services, name) ? services[name] : undefined
    },
    on(event, fn) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      return () => listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== fn))
    },
    effect(fn) {
      disposers.push(fn())
      return () => {}
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    emit(event, ...args) {
      for (const fn of listeners.get(event) ?? []) fn(...args)
    },
    routes,
    disposers,
    listeners,
  }
}

/** A JSON response stand-in. */
function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

/** Install a capturing fetch; returns the recorded calls. */
function stubFetch(handler) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init, calls.length)
  }
  return calls
}

/** A request stand-in with loopback defaults. */
function makeReq({ method = 'GET', remoteAddress = '127.0.0.1', host = '127.0.0.1:3939', origin, secFetchSite } = {}) {
  const headers = { host }
  if (origin !== undefined) headers.origin = origin
  if (secFetchSite !== undefined) headers['sec-fetch-site'] = secFetchSite
  return { method, headers, socket: { remoteAddress } }
}

/** A response stand-in. */
function makeRes() {
  const out = { status: undefined, headers: undefined, body: undefined }
  return {
    writeHead(status, headers) {
      out.status = status
      out.headers = headers
    },
    end(payload) {
      out.body = payload
    },
    out,
  }
}

/* ------------------------------------------------------------------ *
 * 1. Pricing clock and price book
 * ------------------------------------------------------------------ */

const PEAK_AT = Date.parse('2026-10-13T10:00:00+08:00')
const OFF_PEAK_AT = Date.parse('2026-10-13T23:00:00+08:00')

const peak = deepseekPeriodAt(PEAK_AT)
assert.equal(peak.peak, true, 'Tuesday 10:00 Beijing is peak')
assert.equal(peak.boundaryMs, Date.parse('2026-10-13T12:00:00+08:00'), 'the peak period ends at the window close')
const offPeak = deepseekPeriodAt(OFF_PEAK_AT)
assert.equal(offPeak.peak, false, 'Tuesday 23:00 Beijing is off-peak')
assert.equal(offPeak.boundaryMs, Date.parse('2026-10-14T09:00:00+08:00'), 'off-peak waits for the next morning window')
const weekend = deepseekPeriodAt(Date.parse('2026-10-10T10:00:00+08:00'))
assert.equal(weekend.peak, false, 'Saturday is off-peak all day')
assert.equal(deepseekPeriodAt(Date.parse('2026-10-09T17:59:30+08:00')).peak, true, 'the last half minute of a window is still peak')

// Statutory holidays bill the whole day off-peak, and the countdown skips them.
const nationalDay = deepseekPeriodAt(Date.parse('2026-10-06T10:00:00+08:00'))
assert.equal(nationalDay.peak, false, 'Tuesday 10:00 inside the National Day break is off-peak')
assert.equal(nationalDay.boundaryMs, Date.parse('2026-10-08T09:00:00+08:00'), 'the countdown skips the remaining holiday days')
assert.equal(isPublicHoliday(Date.parse('2026-10-06T10:00:00+08:00')), true, 'a National Day date is a holiday')
assert.equal(isPublicHoliday(PEAK_AT), false, 'an ordinary Tuesday is not a holiday')
const springFestival = deepseekPeriodAt(Date.parse('2026-02-17T10:00:00+08:00'))
assert.equal(springFestival.peak, false, 'the Spring Festival break is off-peak all day')
assert.equal(springFestival.boundaryMs, Date.parse('2026-02-24T09:00:00+08:00'), 'the countdown lands on the first working day after the break')
assert.equal(deepseekPeriodAt(Date.parse('2026-02-28T10:00:00+08:00')).peak, false, 'a make-up working Saturday stays off-peak')
// The table stops at 2026; a later year keeps the weekday rule until extended.
assert.equal(deepseekPeriodAt(Date.parse('2027-01-05T10:00:00+08:00')).peak, true, 'an uncovered year falls back to the weekday rule')

assert.equal(beijingDateKey(Date.parse('2026-10-13T23:30:00+08:00')), '2026-10-13', 'day keys follow Beijing time, not the host clock')
assert.equal(beijingDateKey(Date.parse('2026-10-13T00:30:00+08:00')), '2026-10-13', 'just after Beijing midnight is the new day')

const millionInput = { ...emptyTotals(), inputTokens: 1_000_000, calls: 1 }
assert.equal(deepseekModelSpend('deepseek-v4.1-flash', millionInput, PEAK_AT), 2, 'a million peak input tokens cost CNY 2')
assert.equal(deepseekModelSpend('deepseek-v4.1-flash', millionInput, OFF_PEAK_AT), 1, 'the same call off-peak is half price')
assert.equal(deepseekModelSpend('deepseek-v4-pro', millionInput, PEAK_AT), 9, 'v4-pro keeps its own published row')
assert.equal(isDeepSeekRoute('deepseek-official'), true, 'the official route is a DeepSeek route')
assert.equal(isDeepSeekRoute('ali'), false, 'a DashScope-compatible route is not')

/* ------------------------------------------------------------------ *
 * 2. The ledger
 * ------------------------------------------------------------------ */

const doc = createLedgerDocument()
const oneCall = { ...emptyTotals(), inputTokens: 1_000, outputTokens: 100, calls: 1, cost: 0.5 }
foldUsage(doc, PEAK_AT, 'deepseek-official', 'deepseek-v4.1-flash', oneCall)
foldUsage(doc, PEAK_AT + 60_000, 'deepseek-official', 'deepseek-v4.1-flash', oneCall)
assert.equal(doc.days['2026-10-13']['deepseek-official']['deepseek-v4.1-flash'].inputTokens, 2_000, 'folds accumulate')
const folded = summarizeDays([doc.days['2026-10-13']])
assert.equal(folded.totals.calls, 2, 'two calls are summarized')
assert.equal(folded.totals.cost, 1, 'costs sum')
assert.equal(totalTokens(folded.totals), 2_200, 'total tokens count billed input plus output')

foldUsage(doc, PEAK_AT, '__proto__', 'deepseek-v4.1-flash', oneCall)
foldUsage(doc, PEAK_AT, 'deepseek-official', 'constructor', oneCall)
assert.equal(summarizeDays([doc.days['2026-10-13']]).totals.calls, 2, 'prototype-named buckets are refused')
assert.equal(Object.keys(doc.days).length, 1, 'a refused fold creates no day')

foldUsage(doc, Date.parse('2026-01-05T10:00:00+08:00'), 'deepseek-official', 'deepseek-v4.1-flash', oneCall)
assert.equal(Object.keys(doc.days).length, 2, 'an older day lands in its own bucket')
assert.equal(pruneLedger(doc, '2026-10-13', 180), 1, 'retention drops the day outside the window')
assert.deepEqual(Object.keys(doc.days), ['2026-10-13'], 'only the retained day survives')

const revived = deserializeLedger(JSON.parse(JSON.stringify(doc)))
assert.deepEqual(revived.days, doc.days, 'a ledger round-trips through JSON')
const junk = deserializeLedger({
  days: {
    '9999-99-99': { provider: { model: { inputTokens: 5 } } },
    '2026-02-30': { provider: { model: { inputTokens: 5 } } },
    '2026-10-13': { provider: { model: { inputTokens: 7, calls: 'nope', cost: 'x' } } },
  },
})
assert.deepEqual(Object.keys(junk.days), ['2026-10-13'], 'impossible and rollover dates are rejected')
assert.equal(junk.days['2026-10-13'].provider.model.inputTokens, 7, 'a usable row survives')
assert.equal(junk.days['2026-10-13'].provider.model.calls, 0, 'non-numeric counters are coerced')
assert.deepEqual(deserializeLedger(null).days, {}, 'a corrupt document reads as empty')
assert.deepEqual(deserializeLedger({ days: 'nope' }).days, {}, 'an unreadable days map reads as empty')

/* ------------------------------------------------------------------ *
 * 3. Credentials and the balance probe
 * ------------------------------------------------------------------ */

assert.deepEqual(listDeepSeekRoutes(makeCtx()), ['deepseek-official'], 'without the llm registry the official route is still probed')
assert.deepEqual(
  listDeepSeekRoutes(makeCtx({ llm: { listProviders: () => [{ id: 'ali' }, { id: 'deepseek-official', name: 'DeepSeek' }] } })),
  ['deepseek-official'],
  'the live registry decides which DeepSeek routes to probe',
)
assert.deepEqual(
  listDeepSeekRoutes(makeCtx({ llm: { listConfigurableProviders: () => [{ provider: 'deepseek', displayName: 'DeepSeek' }] } })),
  ['deepseek'],
  'without a live route the catalog entry is used',
)

const keyRecordCtx = makeCtx({
  credentials: {
    readRecord: async (key) => (key === 'llm-pi-ai/deepseek-official' ? { kind: 'api-key', key: 'sk-record' } : undefined),
    resolve: async () => ({ value: 'sk-env' }),
  },
})
assert.deepEqual(await resolveCredential(keyRecordCtx, 'deepseek-official'), { kind: 'api-key', key: 'sk-record' }, 'the pi-ai record wins')

const envRefCtx = makeCtx({
  credentials: { readRecord: async () => undefined, resolve: async (ref) => (ref === 'MY_DS_KEY' ? { value: 'sk-env' } : undefined) },
  settings: { get: (ns) => (ns === 'llm-deepseek' ? { apiKeyEnv: 'MY_DS_KEY' } : undefined) },
})
assert.deepEqual(await resolveCredential(envRefCtx, 'deepseek-official'), { kind: 'env', key: 'sk-env' }, 'the configured env reference is resolved')

const emptyRefCtx = makeCtx({ credentials: { readRecord: async () => undefined, resolve: async () => undefined } })
assert.deepEqual(await resolveCredential(emptyRefCtx, 'deepseek-official'), { kind: 'none' }, 'nothing configured reads as none')

process.env.DSH_VERIFY_KEY = 'sk-ambient'
const ambientCtx = makeCtx({})
ambientCtx.get = (name) => (name === 'settings' ? { get: () => ({ apiKeyEnv: 'DSH_VERIFY_KEY' }) } : undefined)
assert.deepEqual(await resolveCredential(ambientCtx, 'deepseek-official'), { kind: 'env', key: 'sk-ambient' }, 'a host without the credentials service still reads the ambient env var')
delete process.env.DSH_VERIFY_KEY

assert.equal(balanceAppliesToRoute(undefined), true, 'no override means the official origin applies')
assert.equal(balanceAppliesToRoute('https://api.deepseek.com/v1'), true, 'the official origin applies')
assert.equal(balanceAppliesToRoute('https://reseller.example/v1'), false, 'a foreign origin must not be probed with the official endpoint')
assert.equal(
  routeBaseUrl(makeCtx({ settings: { get: (ns) => (ns === 'llm-pi-ai' ? { providers: { 'deepseek-official': { baseURL: 'https://reseller.example/v1' } } } : undefined) } }), 'deepseek-official'),
  'https://reseller.example/v1',
  'the route base URL is read from the pi-ai profile',
)

const probeCalls = stubFetch(async () => jsonResponse(200, { balance_infos: [{ currency: 'CNY', total_balance: '10.39' }] }))
const balance = await probeBalance('sk-test')
assert.equal(balance.currency, 'CNY', 'the probe reads the currency')
assert.equal(balance.totalBalance, '10.39', 'the probe keeps the decimal string verbatim')
assert.equal(probeCalls[0].url, 'https://api.deepseek.com/user/balance', 'the official endpoint is called')
assert.equal(probeCalls[0].init.headers.get('authorization'), 'Bearer sk-test', 'the key rides the bearer header')
assert.equal(probeCalls[0].init.headers.get('accept-encoding'), 'identity', 'the host undici quirk is worked around')

stubFetch(async () => jsonResponse(401, { error: 'bad key' }))
await assert.rejects(() => probeBalance('sk-bad'), /HTTP 401/, 'a 401 is reported with its status')
stubFetch(async () => jsonResponse(200, { balance_infos: [] }))
await assert.rejects(() => probeBalance('sk-empty'), /unrecognized response shape/, 'an empty balance list is not a balance')
stubFetch(async () => jsonResponse(200, { nope: true }))
await assert.rejects(() => probeBalance('sk-shape'), /unrecognized response shape/, 'a foreign body is not a balance')
stubFetch(async () => jsonResponse(200, { balance_infos: [{ currency: 'CNY' }] }))
await assert.rejects(() => probeBalance('sk-partial'), /unrecognized response shape/, 'a partial row is not a balance')

/* ------------------------------------------------------------------ *
 * 4. The service: session folding, overview, routes, persistence
 * ------------------------------------------------------------------ */

const PROBE_OK = async () => jsonResponse(200, { balance_infos: [{ currency: 'CNY', total_balance: '10.39' }] })
const services = {
  credentials: { readRecord: async () => ({ kind: 'api-key', key: 'sk-test' }), resolve: async () => undefined },
  settings: { get: (ns) => (ns === 'llm-deepseek' ? { apiKeyEnv: 'DEEPSEEK_API_KEY' } : undefined) },
  llm: { listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'ali', name: 'Ali' }] },
}

const ctx = makeCtx(services)
stubFetch(PROBE_OK)
const service = new AccountGlanceService(ctx)
service.start()
await service.refresh()

const probed = service.overview()
assert.equal(probed.providers.length, 1, 'only the DeepSeek route is probed')
assert.equal(probed.providers[0].provider, 'deepseek-official', 'the probed route id is reported')
assert.equal(probed.providers[0].credential, 'api-key', 'the credential kind is reported')
assert.deepEqual(
  { currency: probed.providers[0].balance.currency, totalBalance: probed.providers[0].balance.totalBalance },
  { currency: 'CNY', totalBalance: '10.39' },
  'the probe balance is reported',
)
assert.equal(probed.usage.today.date, beijingDateKey(realNow()), "today's bucket is keyed by the Beijing date")
assert.deepEqual(probed.usage.today.totals, emptyTotals(), 'a fresh ledger starts at zero')
assert.deepEqual(probed.usage.days, [], 'a fresh ledger has no trend days')

const session = {}
Date.now = () => PEAK_AT
ctx.emit('session/event', session, { type: 'request/header', data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4.1-flash' } } } })
ctx.emit('session/event', session, { type: 'assistant/message', data: { usage: { inputTokens: 1_000_000, outputTokens: 0 } } })
const peakDay = service.overview().usage.today
assert.equal(peakDay.totals.calls, 1, 'one usage-reporting message is one call')
assert.equal(peakDay.totals.inputTokens, 1_000_000, 'the tokens are folded')
assert.equal(peakDay.totals.cost, 2, 'a DeepSeek call is priced at the peak column')
assert.equal(peakDay.providers[0].provider, 'deepseek-official', "today's provider summary names the route")
assert.deepEqual(service.overview().usage.days.map((day) => day.date), ['2026-10-13'], 'the folded day appears in the trend window')

Date.now = () => OFF_PEAK_AT
ctx.emit('session/event', session, { type: 'assistant/message', data: { usage: { inputTokens: 1_000_000, outputTokens: 0 } } })
const offPeakDay = service.overview().usage.today
assert.equal(offPeakDay.totals.cost, 3, 'the second call is priced at the off-peak column')

// A route that is not DeepSeek counts tokens but is never priced, so a mixed
// ledger cannot sum two currencies.
ctx.emit('session/event', session, { type: 'request/context', data: { provider: 'ali', model: 'deepseek-v4.1-flash' } })
ctx.emit('session/event', session, { type: 'assistant/message', data: { usage: { inputTokens: 500, outputTokens: 10 } } })
const mixed = service.overview().usage.today
assert.equal(mixed.totals.calls, 3, 'the foreign route still counts its call')
assert.equal(mixed.totals.cost, 3, 'the foreign route adds no cost')

// Usage arriving with no route attribution yet is dropped, not guessed.
const unattributed = {}
ctx.emit('session/event', unattributed, { type: 'assistant/message', data: { usage: { inputTokens: 9_999, outputTokens: 9_999 } } })
assert.equal(service.overview().usage.today.totals.calls, 3, 'an unattributed message is dropped')
// A malformed event must not break the loop.
ctx.emit('session/event', session, { type: 'assistant/message', data: null })
ctx.emit('session/event', session, { type: 'request/header', data: { header: null } })
assert.equal(service.overview().usage.today.totals.calls, 3, 'malformed events are dropped')

// The service joins an in-flight cycle instead of starting a second probe.
const joinCalls = stubFetch(PROBE_OK)
await Promise.all([service.pollNow(), service.pollNow()])
assert.equal(joinCalls.length, 1, 'concurrent refreshes join one probe cycle')

// A failing probe keeps the last good number and flags the row.
stubFetch(async () => jsonResponse(401, { error: 'bad key' }))
await service.refresh()
const failedRow = service.overview().providers[0]
assert.equal(failedRow.balance.totalBalance, '10.39', 'a failed probe keeps the last good balance')
assert.match(failedRow.error, /HTTP 401/, 'a failed probe is reported')

// A route pointed at another origin is not probed with the official endpoint.
stubFetch(async () => { throw new Error('must not be called') })
const foreignCtx = makeCtx({
  ...services,
  settings: { get: (ns) => (ns === 'llm-pi-ai' ? { providers: { 'deepseek-official': { baseURL: 'https://reseller.example/v1' } } } : undefined) },
})
const foreignService = new AccountGlanceService(foreignCtx)
foreignService.start()
await foreignService.refresh()
const foreignRow = foreignService.overview().providers[0]
assert.equal(foreignRow.balanceSupported, false, 'a foreign origin reports the balance as unsupported')
assert.equal(foreignRow.balance, undefined, 'a foreign origin shows no official balance')
await foreignService.stop()

// A store with no credential keeps counting usage but shows no balance.
stubFetch(PROBE_OK)
const bareCtx = makeCtx({ credentials: { readRecord: async () => undefined, resolve: async () => undefined } })
const bareService = new AccountGlanceService(bareCtx)
bareService.start()
await bareService.refresh()
const bareRow = bareService.overview().providers[0]
assert.equal(bareRow.balance, undefined, 'no credential means no balance')
assert.equal(bareRow.error, undefined, 'no credential is not a probe failure')
await bareService.stop()

/* Routes: fence, verbs, and the payload the browser reads. */

ctx.webServer.register(makeOverviewRoute(ctx, service))
ctx.webServer.register(makeRefreshRoute(ctx, service))
const overviewRoute = ctx.routes.find((route) => route.path === '/api/dsh-account-glance/overview')
const refreshRoute = ctx.routes.find((route) => route.path === '/api/dsh-account-glance/refresh')
assert.ok(overviewRoute !== undefined && refreshRoute !== undefined, 'both routes are registered')

const okRes = makeRes()
await overviewRoute.handler(makeReq(), okRes)
assert.equal(okRes.out.status, 200, 'a loopback read is served')
assert.equal(okRes.out.headers['cache-control'], 'no-store', 'the overview is never cached')
assert.equal(okRes.out.headers['content-type'], 'application/json; charset=utf-8', 'the overview is JSON')
assert.equal(JSON.parse(okRes.out.body).providers.length, 1, 'the served document carries the provider rows')

const lanRes = makeRes()
await overviewRoute.handler(makeReq({ remoteAddress: '192.168.1.20', host: '192.168.1.20:3939' }), lanRes)
assert.equal(lanRes.out.status, 403, 'an unpaired LAN read is refused')
assert.equal(JSON.parse(lanRes.out.body).error, 'forbidden: loopback-only', 'the refusal names the fence')

const crossSiteRes = makeRes()
await overviewRoute.handler(makeReq({ origin: 'https://evil.example', secFetchSite: 'cross-site' }), crossSiteRes)
assert.equal(crossSiteRes.out.status, 403, 'a cross-site browser request is refused')

const pairedCtx = makeCtx({ ...services, remoteWebUiPairing: { isPairedDevice: () => true } })
const pairedService = new AccountGlanceService(pairedCtx)
pairedService.start()
const pairedRoute = makeOverviewRoute(pairedCtx, pairedService)
const pairedRes = makeRes()
await pairedRoute.handler(makeReq({ remoteAddress: '192.168.1.20', host: '192.168.1.20:3939' }), pairedRes)
assert.equal(pairedRes.out.status, 200, 'a live paired device is allowed through the same fence')
await pairedService.stop()

const getRefreshRes = makeRes()
await refreshRoute.handler(makeReq({ method: 'GET' }), getRefreshRes)
assert.equal(getRefreshRes.out.status, 405, 'the refresh route refuses a non-POST verb')

const refreshCalls = stubFetch(PROBE_OK)
const postRes = makeRes()
await refreshRoute.handler(makeReq({ method: 'POST' }), postRes)
assert.equal(postRes.out.status, 200, 'a POST refresh is served')
assert.equal(refreshCalls.length, 1, 'a refresh forces exactly one probe cycle')
assert.equal(JSON.parse(postRes.out.body).providers.length, 1, 'the refresh answers with the fresh overview')

/* Persistence across a restart, and retention of an old day. */

await settleIo()
service.scheduleFlush()
await service.flushLedger()
const ledgerPath = join(DSH_HOME, 'account-glance', 'ledger.json')
assert.equal(existsSync(ledgerPath), true, 'the ledger is written under DSH_HOME')

const raw = JSON.parse(readFileSync(ledgerPath, 'utf8'))
const todayKey = beijingDateKey(PEAK_AT)
assert.equal(raw.days[todayKey]['deepseek-official']['deepseek-v4.1-flash'].calls, 2, 'the DeepSeek calls are filed under their route')
assert.equal(raw.days[todayKey].ali['deepseek-v4.1-flash'].calls, 1, 'the foreign route keeps its own bucket')
const beforeRestart = service.overview().usage.today.totals
raw.days['2020-01-01'] = { 'deepseek-official': { 'deepseek-v4.1-flash': { ...emptyTotals(), inputTokens: 1, calls: 1 } } }
writeFileSync(ledgerPath, JSON.stringify(raw), 'utf8')

const restarted = new AccountGlanceService(makeCtx(services))
await restarted.loadPersisted()
const reloaded = restarted.overview()
assert.deepEqual(reloaded.usage.today.totals, beforeRestart, 'the ledger survives a restart with the same totals')
assert.equal(reloaded.usage.today.totals.cost, 3, 'the cost column survives a restart')
assert.deepEqual(
  reloaded.usage.days.map((day) => day.date).filter((date) => date === '2020-01-01'),
  [],
  'a day outside retention is pruned on load',
)
await restarted.stop()
await service.stop()

/* ------------------------------------------------------------------ *
 * 5. The host entry point
 * ------------------------------------------------------------------ */

const applyCtx = makeCtx(services)
apply(applyCtx)
assert.deepEqual(
  applyCtx.routes.map((route) => route.path).sort(),
  ['/api/dsh-account-glance/overview', '/api/dsh-account-glance/refresh'],
  'apply() registers exactly the two routes',
)
assert.equal(applyCtx.disposers.length, 1, 'apply() installs one fiber effect')
applyCtx.disposers[0]()
assert.equal(applyCtx.routes.length, 0, 'disposing the fiber unregisters both routes')

/* ------------------------------------------------------------------ *
 * Cleanup
 * ------------------------------------------------------------------ */

Date.now = realNow
globalThis.fetch = realFetch
rmSync(DSH_HOME, { recursive: true, force: true })

console.log('dsh-account-glance host: all checks passed')
console.log('  pricing      peak/off-peak + Beijing day keys')
console.log('  ledger       fold, prune, revival, prototype guard')
console.log('  probe        credentials, parse, failures, origin guard')
console.log('  service      session fold, routes, persistence')
console.log('  entry        lib/index.js apply()')