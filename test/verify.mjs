/**
 * Offline acceptance test for dsh-account-glance.
 *
 * The bundle is the shipped artifact, so this test executes THAT file — the same
 * bytes the client module system serves — against a minimal stand-in for the
 * browser and for React. It proves, without a browser:
 *
 *  1. the bundle registers exactly one factory under the package name the boot
 *     graph row carries (`dsh-account-glance`), and requires nothing but `react`;
 *  2. `apply()` claims the `sidebar.footer.action` seat with the expected id and
 *     order, installs the stylesheet, and starts its polls;
 *  3. the account Remote is called with a well-formed client identity and its
 *     wallet is formatted into the headline;
 *  4. the DeepSeek peak / off-peak clock is correct at the window boundaries,
 *     across nights, weekends and the Monday-morning gap, with a live countdown;
 *  5. today's ledger line comes from this plugin's own host route, with
 *     @linxin666/dsh-usage's overview as the 404 fallback, and the API-key
 *     balance probe outranks the personal-account Remote.
 *
 * Run with the DSH runtime's Node: `node test/verify.mjs`.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const BUNDLE = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

const PACKAGE_NAME = 'dsh-account-glance'
const SEAT = 'sidebar.footer.action'

/** Captured before any stubbing so the harness's own waits keep working. */
const realSetTimeout = globalThis.setTimeout

/** Ledger totals the stubbed usage endpoint reports. */
const OVERVIEW = {
  providers: [
    { provider: 'deepseek-official', displayName: 'DeepSeek', credential: 'env', supported: true, balance: { currency: 'CNY', totalBalance: '9.99', updatedAt: 1 } },
  ],
  usage: {
    today: {
      date: '2026-10-06',
      totals: { inputTokens: 12_345, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 42, cost: 1.82 },
      providers: [],
    },
    days: [],
  },
}

/* ------------------------------------------------------------------ *
 * Browser / React stand-ins
 * ------------------------------------------------------------------ */

/** Flatten the variadic children `createElement` receives. */
function flatten(children) {
  const out = []
  for (const child of children) {
    if (Array.isArray(child)) out.push(...flatten(child))
    else out.push(child)
  }
  return out
}

/** The smallest React surface the card uses. */
const React = {
  createElement(type, props, ...children) {
    return { type, props: props === null || props === undefined ? {} : props, children: flatten(children) }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useSyncExternalStore(_subscribe, getSnapshot) {
    return getSnapshot()
  },
}

/** A document with just enough surface for the stylesheet + visibility gate. */
function makeDocument(styles) {
  const node = () => ({ id: '', textContent: '', remove() {} })
  return {
    visibilityState: 'visible',
    head: { appendChild: (child) => styles.push(child) },
    documentElement: { appendChild: (child) => styles.push(child) },
    getElementById: () => null,
    createElement: node,
    addEventListener() {},
    removeEventListener() {},
  }
}

/** Render an element tree to its text content, invoking function components. */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  return (node.children ?? []).map(textOf).join('')
}

/** Walk the tree and collect every `data-dsh-part` a node carries. */
function partsOf(node, found = new Set()) {
  if (node === null || node === undefined || typeof node === 'boolean') return found
  if (typeof node === 'string' || typeof node === 'number') return found
  if (Array.isArray(node)) {
    for (const child of node) partsOf(child, found)
    return found
  }
  if (typeof node.type === 'function') {
    partsOf(node.type(node.props), found)
    return found
  }
  if (node.props?.['data-dsh-part'] !== undefined) found.add(node.props['data-dsh-part'])
  for (const child of node.children ?? []) partsOf(child, found)
  return found
}

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

/** Intervals the card's source loop arms; reset per boot. */
const intervals = []

/** Capture the one bundle registration. */
let registration
const fakeWindow = {
  __ModuleLoader__: { load: (value) => { registration = value } },
  // The source loop's cadence is asserted through this recorder; the component's
  // own 1 s countdown tick lives in a useEffect, which the React stand-in skips.
  setInterval: (_callback, ms) => {
    intervals.push(ms)
    return 0
  },
  clearInterval: () => {},
}
new Function('window', BUNDLE)(fakeWindow)

assert.ok(registration !== undefined, 'bundle must call window.__ModuleLoader__.load')
assert.equal(registration.id, PACKAGE_NAME, 'bundle id must be the resolved package name')
assert.equal(typeof registration.factory, 'function', 'bundle must expose a factory')

/** Materialize fresh exports (the module body is lazy, so this is repeatable). */
function materialize() {
  const required = []
  const exported = registration.factory((spec) => {
    required.push(spec)
    if (spec === 'react') return React
    throw new Error('unexpected require: ' + spec)
  })
  return { exported, required }
}

const { exported, required } = materialize()
assert.deepEqual(required, ['react'], 'react must be the only external')
assert.deepEqual(exported.inject, ['slots', 'locale', 'remote'], 'the three services the card needs')
assert.equal(typeof exported.apply, 'function', 'exports.apply must be callable')

/** Boot one plugin instance against stubbed account / usage sources. */
async function boot({ getBalance, overview = OVERVIEW, active = 'zh-CN', accountService = true, usageStatus = 200, overviewPaths } = {}) {
  const styles = []
  const seats = []
  const injectedNames = []
  const identities = []
  const fetches = []
  globalThis.document = makeDocument(styles)
  globalThis.fetch = async (url, init) => {
    fetches.push({ url, method: init?.method ?? 'GET' })
    const status = overviewPaths === undefined || overviewPaths === null
      ? usageStatus
      : (overviewPaths[url] ?? usageStatus)
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => overview,
    }
  }

  const ctx = {
    locale: { getSnapshot: () => ({ active }), subscribe: () => () => {} },
    remote: {},
    slots: {
      inject: (name, callback) => {
        injectedNames.push(name)
        callback()
      },
      register: (options, component) => {
        seats.push({ options, component })
        return () => {}
      },
    },
    effect: (callback) => callback(),
  }
  if (accountService) {
    ctx.remote.account = {
      getBalance: async (identity) => {
        identities.push(identity)
        return getBalance === undefined
          ? { ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: '11.74' }], bonusWallets: [{ currency: 'CNY', balance: '2.00' }] } }
          : getBalance()
      },
    }
  }

  intervals.length = 0
  exported.apply(ctx)
  // Let both one-shot reads settle (account Remote + usage fetch/json).
  await new Promise((resolve) => realSetTimeout(resolve, 5))

  assert.equal(styles.length, 1, 'exactly one stylesheet is installed')
  return { ctx, styles, seats, injectedNames, identities, fetches, intervals: [...intervals] }
}

/**
 * Capture the client's own timers instead of running them, so a deadline the
 * card arms can be fired deterministically.
 */
function captureTimers() {
  const captured = []
  globalThis.setTimeout = (callback, ms) => {
    captured.push({ callback, ms })
    return captured.length
  }
  return {
    captured,
    fire(ms) {
      const index = captured.findIndex((timer) => timer.ms === ms)
      if (index < 0) return false
      const [timer] = captured.splice(index, 1)
      timer.callback()
      return true
    },
    restore() {
      globalThis.setTimeout = realSetTimeout
    },
  }
}

/** Depth-first search for the first element node satisfying `predicate`. */
function findNode(node, predicate) {
  if (node === null || node === undefined || typeof node === 'boolean') return undefined
  if (typeof node === 'string' || typeof node === 'number') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findNode(child, predicate)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (typeof node.type === 'function') return findNode(node.type(node.props), predicate)
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const hit = findNode(child, predicate)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** Render one boot's card to text. */
function renderText(booted) {
  const target = booted.seats[0]
  return textOf(target.component({ ...target.options.inject(), wide: true }))
}

/* ------------------------------------------------------------------ *
 * 1. Seating and wiring
 * ------------------------------------------------------------------ */

const first = await boot()
assert.deepEqual(first.injectedNames, [SEAT], 'the card waits for the sidebar foot seat')
assert.equal(first.seats.length, 1, 'exactly one seat is claimed')
const seat = first.seats[0]
assert.equal(seat.options.name, SEAT, 'seat name')
assert.equal(seat.options.id, 'account-glance', 'seat id')
assert.equal(seat.options.order, 50, 'seat order (after the shell foot actions)')
assert.equal(typeof seat.options.inject, 'function', 'the seat exposes its business share')

const share = seat.options.inject()
assert.ok(share.store, 'the share carries the store')
assert.ok(share.locale, 'the share carries the locale source')
assert.deepEqual(first.intervals, [60000], 'the card arms one 60 s cadence, matching the provider probe interval')

/* ------------------------------------------------------------------ *
 * 2. The card renders balance, period and ledger
 * ------------------------------------------------------------------ */

const realNow = Date.now
const FROZEN = Date.parse('2026-10-06T10:00:00+08:00')
Date.now = () => FROZEN

const element = seat.component({ ...share, wide: true })
const text = textOf(element)
assert.match(text, /个人账户/, 'headline label')
assert.match(text, /个人账户¥9\.99/, 'the API-key probe is the authoritative headline')
assert.doesNotMatch(text, /\*/, 'the probe value carries no star marker')
assert.match(text, /峰时 · 原价/, 'Tuesday 10:00 Beijing is peak')
assert.match(text, /距转谷 2 小时 0 分/, 'countdown to the 12:00 window close')
assert.match(text, /今日 ¥1\.82 · 12\.3k tokens · 42 次/, "today's ledger line")
assert.deepEqual(
  [...partsOf(element)].sort(),
  ['countdown', 'refresh', 'usage'],
  'the countdown, usage and refresh parts stay addressable for inspection',
)
assert.equal(
  first.identities.length,
  0,
  'a probe balance means the account Remote is never consulted',
)
const headlineValue = findNode(element, (node) => typeof node.props?.title === 'string' && node.props.title.startsWith('余额来源'))
assert.ok(headlineValue !== undefined, 'the headline names its source on hover')
assert.match(headlineValue.props.title, /API Key/, 'the source title names the probe')

/* ------------------------------------------------------------------ *
 * 2b. Manual refresh
 * ------------------------------------------------------------------ */

const manual = await boot()
const manualSeat = manual.seats[0]
const manualCard = manualSeat.component({ ...manualSeat.options.inject(), wide: true })
const refreshButton = findNode(manualCard, (node) => node.props?.['data-dsh-part'] === 'refresh')
assert.ok(refreshButton !== undefined, 'the card carries a manual refresh control')
assert.equal(refreshButton.type, 'button', 'the control is a real button')
assert.equal(refreshButton.props['aria-label'], '刷新', 'the button is labelled for assistive tech')
assert.equal(refreshButton.props.disabled, false, 'the button is enabled while idle')
assert.equal(manual.fetches.filter((entry) => entry.method === 'POST').length, 0, 'the poll cadence never forces a probe')

refreshButton.props.onClick()
await new Promise((resolve) => realSetTimeout(resolve, 5))
assert.deepEqual(
  manual.fetches.filter((entry) => entry.method === 'POST'),
  [{ url: 'api/dsh-account-glance/refresh', method: 'POST' }],
  'one click forces exactly one host probe cycle',
)
assert.equal(manual.identities.length, 0, 'a click does not touch the account Remote while a probe exists')
assert.match(
  renderText(manual),
  /个人账户¥9\.99/,
  'the refreshed headline still shows the probe value',
)

// With no probe the same click also re-reads the account Remote.
const manualFallback = await boot({ overview: { providers: [], usage: OVERVIEW.usage } })
const fallbackSeat = manualFallback.seats[0]
const fallbackCard = fallbackSeat.component({ ...fallbackSeat.options.inject(), wide: true })
findNode(fallbackCard, (node) => node.props?.['data-dsh-part'] === 'refresh').props.onClick()
await new Promise((resolve) => realSetTimeout(resolve, 5))
assert.equal(manualFallback.identities.length, 2, 'with no probe a click re-reads the account Remote too')

// A localised label follows the active language.
const manualEn = await boot({ active: 'en-US' })
const enCard = manualEn.seats[0].component({ ...manualEn.seats[0].options.inject(), wide: true })
assert.equal(findNode(enCard, (node) => node.props?.['data-dsh-part'] === 'refresh').props['aria-label'], 'Refresh', 'english button label')

/* The account Remote identity the Host turns into Platform request headers. */
const accountPath = await boot({ overview: { providers: [], usage: OVERVIEW.usage } })
assert.equal(accountPath.identities.length, 1, 'the account Remote is read once when the probe is missing')
assert.deepEqual(Object.keys(accountPath.identities[0]).sort(), ['locale', 'timezoneOffsetSeconds', 'version'])
assert.equal(accountPath.identities[0].locale, 'zh-CN')
assert.equal(typeof accountPath.identities[0].version, 'string')
assert.ok(accountPath.identities[0].version.length > 0, 'a version must be present')
assert.match(renderText(accountPath), /个人账户¥11\.74/, 'the account wallet carries the headline when there is no probe')

/* ------------------------------------------------------------------ *
 * 3. The peak / off-peak clock across every boundary shape
 * ------------------------------------------------------------------ */

const CLOCK_CASES = [
  { at: '2026-10-06T10:00:00+08:00', badge: '峰时 · 原价', countdown: '距转谷 2 小时 0 分', why: 'inside the morning window' },
  { at: '2026-10-06T12:30:00+08:00', badge: '谷时 · 5 折', countdown: '距转峰 1 小时 30 分', why: 'lunch gap' },
  { at: '2026-10-06T20:00:00+08:00', badge: '谷时 · 5 折', countdown: '距转峰 13 小时 0 分', why: 'overnight' },
  { at: '2026-10-09T17:59:30+08:00', badge: '峰时 · 原价', countdown: '距转谷 30 秒', why: 'last half minute of the peak window' },
  { at: '2026-10-10T10:00:00+08:00', badge: '谷时 · 5 折', countdown: '距转峰 47 小时 0 分', why: 'weekend waits for Monday 09:00' },
  { at: '2026-10-12T08:00:00+08:00', badge: '谷时 · 5 折', countdown: '距转峰 1 小时 0 分', why: 'pre-open Monday' },
]
for (const testCase of CLOCK_CASES) {
  const at = Date.parse(testCase.at)
  Date.now = () => at
  const rendered = textOf(seat.component({ ...share, wide: true }))
  assert.match(rendered, new RegExp(testCase.badge.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), testCase.at + ' (' + testCase.why + '): badge')
  assert.match(rendered, new RegExp(testCase.countdown.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), testCase.at + ' (' + testCase.why + '): countdown')
}

/* ------------------------------------------------------------------ *
 * 4. Degraded sources
 * ------------------------------------------------------------------ */

// The probe wins even when the account Remote answers: the account call is
// skipped entirely, so a signed-in setup never pays for it either.
const probeWins = await boot({ getBalance: () => ({ ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: '11.74' }], bonusWallets: [] } }) })
assert.match(renderText(probeWins), /个人账户¥9\.99/, 'the probe outranks the account wallet')
assert.equal(probeWins.identities.length, 0, 'the account Remote is skipped while a probe exists')

// No probe at all: the account Remote becomes the source, still unmarked.
const accountOnly = await boot({ overview: { providers: [], usage: OVERVIEW.usage } })
const accountOnlyText = renderText(accountOnly)
assert.match(accountOnlyText, /个人账户¥11\.74/, 'the account wallet is the headline with no probe')
assert.doesNotMatch(accountOnlyText, /\*/, 'the account source carries no star marker')

// No probe and signed out: the headline says so.
const signedOutAlone = await boot({ getBalance: () => ({ ok: true, value: null }), overview: { providers: [], usage: OVERVIEW.usage } })
assert.match(renderText(signedOutAlone), /未登录/, 'a signed-out account with no probe says so')

// No probe, a throwing balance read, and no account service: the card reports
// the failure instead of inventing a number.
const nothing = await boot({
  getBalance: () => { throw new Error('platform down') },
  overview: { providers: [], usage: OVERVIEW.usage },
})
assert.match(renderText(nothing), /读取失败/, 'with no source at all the headline says the read failed')

const noService = await boot({ accountService: false, overview: { providers: [], usage: OVERVIEW.usage } })
assert.match(renderText(noService), /读取失败/, 'a host without the account Remote reads as failed, not blank')

// A stalled account fallback still lands: "读取中…" for as long as it is in
// flight, then the deadline settles it into the failure state.
const timers = captureTimers()
const stalled = await boot({ getBalance: () => new Promise(() => {}), overview: { providers: [], usage: OVERVIEW.usage } })
assert.match(renderText(stalled), /读取中…/, 'a stalled fallback shows its loading state')
assert.equal(stalled.seats[0].options.inject().store.getSnapshot().balance.kind, 'loading', 'the fallback is still in flight')
assert.ok(timers.fire(15_000), 'the stalled fallback armed a deadline')
await new Promise((resolve) => realSetTimeout(resolve, 5))
timers.restore()
assert.equal(stalled.seats[0].options.inject().store.getSnapshot().balance.kind, 'failed', 'the deadline settles the fallback')
assert.match(renderText(stalled), /读取失败/, 'the headline leaves the loading state')

// The ledger line survives a balance failure.
const ledgerKept = await boot({ getBalance: () => { throw new Error('platform down') }, overview: { providers: [], usage: OVERVIEW.usage } })
assert.match(renderText(ledgerKept), /今日 ¥1\.82/, 'the ledger line survives a balance failure')

// A usage host that is off (404) drops the ledger line instead of erroring.
const noUsage = await boot({ usageStatus: 404 })
assert.match(renderText(noUsage), /今日用量不可用/, 'a missing usage host reads as unavailable, not as an error')
// A usage host that fails outright reads the same way.
const badUsage = await boot({ usageStatus: 500 })
assert.match(renderText(badUsage), /今日用量不可用/, 'a failing usage host reads as unavailable')

// A host that has not remounted the new host half: this plugin's own route
// 404s, so the card falls back to dsh-usage's overview and keeps its lines.
const hostFallback = await boot({
  overviewPaths: { 'api/dsh-account-glance/overview': 404, 'api/dsh-usage/overview': 200 },
})
assert.deepEqual(
  hostFallback.fetches.map((entry) => entry.url),
  ['api/dsh-account-glance/overview', 'api/dsh-usage/overview'],
  'a missing own host route falls back to the dsh-usage overview',
)
assert.match(renderText(hostFallback), /今日 ¥1\.82 · 12\.3k tokens · 42 次/, 'the fallback source still renders the ledger line')
assert.match(renderText(hostFallback), /个人账户¥9\.99/, 'the fallback probe still carries the headline')

// An empty day reports no usage rather than a zero-cost line.
const emptyDay = await boot({
  overview: { providers: [], usage: { today: { date: '2026-10-06', totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 0, cost: 0 }, providers: [] }, days: [] } },
})
assert.match(renderText(emptyDay), /今日暂无用量/, 'a day without calls reports no usage')

// A host that ships the cost as a decimal string must not take the card down.
const stringCost = await boot({
  overview: {
    providers: OVERVIEW.providers,
    usage: { today: { date: '2026-10-06', totals: { ...OVERVIEW.usage.today.totals, cost: '1.82' }, providers: [] }, days: [] },
  },
})
assert.match(renderText(stringCost), /今日 ¥1\.82 · 12\.3k tokens · 42 次/, 'a string cost is coerced, not fatal')

// English copy follows the active locale.
const english = await boot({ active: 'en-US' })
const englishText = renderText(english)
assert.match(englishText, /Account/, 'english headline')
assert.match(englishText, /(Peak|Off-peak)/, 'english period badge')
assert.match(englishText, /Today ¥1\.82 · 12\.3k tokens · 42 calls/, 'english ledger line')

Date.now = realNow

console.log('dsh-account-glance: all checks passed')
console.log('  seat          ' + SEAT + ' #' + seat.options.id + ' order=' + seat.options.order)
console.log('  clock cases   ' + CLOCK_CASES.length)
console.log('  externals     ' + required.join(', '))
