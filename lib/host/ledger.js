/**
 * The usage ledger: a pure fold from session usage facts into a per-day,
 * per-provider, per-model totals document, plus its JSON serialization.
 *
 * Derived from @linxin666/dsh-usage 0.4.4 (Apache-2.0,
 * https://github.com/zhu1090093659/dsh-web) — `src/core/ledger.ts`. Changed:
 * day keys come from the Beijing clock (see `./pricing.js`) and pruning is
 * derived from that key space, so the ledger no longer depends on the host
 * timezone.
 */

import { beijingDateKey } from "./pricing.js";

/** An all-zero totals bucket. */
export function emptyTotals() {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		calls: 0,
		cost: 0,
	};
}

/** Add `source` into `target` in place. */
export function addTotals(target, source) {
	target.inputTokens += source.inputTokens;
	target.outputTokens += source.outputTokens;
	target.cacheReadTokens += source.cacheReadTokens;
	target.cacheWriteTokens += source.cacheWriteTokens;
	target.reasoningTokens += source.reasoningTokens;
	target.calls += source.calls;
	target.cost += source.cost;
	return target;
}

/** Total tokens of a bucket (billed input + output; reasoning is inside output). */
export function totalTokens(totals) {
	return totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens + totals.outputTokens;
}

/** An empty ledger document. */
export function createLedgerDocument() {
	return { version: 1, days: {} };
}

/**
 * Bucket keys come from untrusted directions (persisted JSON, provider and
 * model ids out of session events), so they must never collide with
 * `Object.prototype` plumbing.
 */
function isSafeBucketKey(key) {
	return key !== "__proto__" && key !== "constructor" && key !== "prototype";
}

/**
 * Fold one usage report into the ledger in place. `provider` is the route key
 * and `model` the provider-owned model id the step ran under.
 * @param doc - the ledger document.
 * @param atMs - the fold instant.
 * @param provider - provider route key.
 * @param model - model id.
 * @param usage - the call's token totals.
 */
export function foldUsage(doc, atMs, provider, model, usage) {
	if (!isSafeBucketKey(provider) || !isSafeBucketKey(model)) return;
	if (usage.calls <= 0 && usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens <= 0) return;
	const dayKey = beijingDateKey(atMs);
	const day = doc.days[dayKey] ?? {};
	const models = day[provider] ?? {};
	const totals = models[model] ?? emptyTotals();
	addTotals(totals, usage);
	models[model] = totals;
	day[provider] = models;
	doc.days[dayKey] = day;
}

/** How many model rows one summarized provider keeps. */
const SUMMARY_MODEL_CAP = 12;

/**
 * Aggregate whole per-day maps (each `provider -> model -> totals`) into the
 * per-provider/per-model summary the overview serves. Pure.
 * @param days - the day buckets to sum.
 * @returns `{ totals, providers }`.
 */
export function summarizeDays(days) {
	const merged = new Map();
	for (const day of days) {
		for (const [provider, models] of Object.entries(day)) {
			if (!isSafeBucketKey(provider) || typeof models !== "object" || models === null) continue;
			let modelMap = merged.get(provider);
			if (modelMap === undefined) {
				modelMap = new Map();
				merged.set(provider, modelMap);
			}
			for (const [model, totals] of Object.entries(models)) {
				if (typeof totals !== "object" || totals === null) continue;
				const bucket = modelMap.get(model) ?? emptyTotals();
				addTotals(bucket, totals);
				modelMap.set(model, bucket);
			}
		}
	}
	const providers = [];
	const totals = emptyTotals();
	for (const [provider, modelMap] of merged) {
		const providerTotals = emptyTotals();
		const modelRows = [...modelMap].map(([model, modelTotals]) => ({ model, totals: modelTotals }));
		for (const row of modelRows) addTotals(providerTotals, row.totals);
		modelRows.sort((a, b) => totalTokens(b.totals) - totalTokens(a.totals));
		providers.push({ provider, totals: providerTotals, models: modelRows.slice(0, SUMMARY_MODEL_CAP) });
	}
	providers.sort((a, b) => totalTokens(b.totals) - totalTokens(a.totals));
	for (const row of providers) addTotals(totals, row.totals);
	return { totals, providers };
}

/** All day keys in the ledger, ascending. */
export function ledgerDayKeys(doc) {
	return Object.keys(doc.days).sort();
}

/**
 * Drop every day older than `retainDays` before `todayKey`, in place. The
 * cutoff is plain date arithmetic on the same Beijing key space, so no host
 * timezone enters the decision.
 * @param doc - the ledger document.
 * @param todayKey - today's `YYYY-MM-DD` key.
 * @param retainDays - days to keep.
 * @returns the number of pruned days.
 */
export function pruneLedger(doc, todayKey, retainDays) {
	const base = Date.parse(todayKey + "T00:00:00Z");
	if (!Number.isFinite(base)) return 0;
	const cutoffKey = new Date(base - retainDays * 86_400_000).toISOString().slice(0, 10);
	let pruned = 0;
	for (const key of Object.keys(doc.days)) {
		if (key < cutoffKey) {
			delete doc.days[key];
			pruned += 1;
		}
	}
	return pruned;
}

function reviveTotals(value) {
	if (typeof value !== "object" || value === null) return undefined;
	const num = (key) => (typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] : 0);
	return {
		inputTokens: num("inputTokens"),
		outputTokens: num("outputTokens"),
		cacheReadTokens: num("cacheReadTokens"),
		cacheWriteTokens: num("cacheWriteTokens"),
		reasoningTokens: num("reasoningTokens"),
		calls: num("calls"),
		cost: num("cost"),
	};
}

/**
 * Parse a ledger document from untrusted JSON: unknown shapes resolve to an
 * empty document, malformed entries are dropped, numbers are coerced to finite
 * values. Never throws.
 * @param value - the parsed JSON value.
 * @returns a ledger document.
 */
export function deserializeLedger(value) {
	const doc = createLedgerDocument();
	if (typeof value !== "object" || value === null) return doc;
	const days = value.days;
	if (typeof days !== "object" || days === null) return doc;
	for (const [dateKey, providers] of Object.entries(days)) {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || typeof providers !== "object" || providers === null) continue;
		// Round-trip the date key: an impossible date parses to NaN and a
		// rollover lands on another day; both would otherwise fold into a bogus,
		// never-pruned bucket.
		const atMs = Date.parse(dateKey + "T12:00:00Z");
		if (!Number.isFinite(atMs) || beijingDateKey(atMs) !== dateKey) continue;
		for (const [provider, models] of Object.entries(providers)) {
			if (typeof models !== "object" || models === null) continue;
			for (const [model, totals] of Object.entries(models)) {
				const revived = reviveTotals(totals);
				if (revived !== undefined) foldUsage(doc, atMs, provider, model, revived);
			}
		}
	}
	return doc;
}