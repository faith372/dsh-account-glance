/**
 * The dsh-account-glance host service: folds live session usage into a
 * persistent ledger, probes the DeepSeek official account balance, and
 * assembles the overview document the sidebar card renders.
 *
 * Derived from @linxin666/dsh-usage 0.4.4 (Apache-2.0,
 * https://github.com/zhu1090093659/dsh-web) — `src/host/usage-service.ts`.
 * Changed: DeepSeek-family providers only, no plan / quota probing, no voucher
 * or observed-spend watch, fixed cadence and retention instead of a settings
 * form, Beijing day buckets, and an overview carrying exactly what the card
 * reads (provider balances + today's totals).
 */

import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dshHome } from "./dsh-home.js";
import { holidayDates, loadHolidayOverride } from "./holidays.js";
import { beijingDateKey, deepseekModelSpend, isDeepSeekRoute } from "./pricing.js";
import {
	createLedgerDocument,
	deserializeLedger,
	emptyTotals,
	foldUsage,
	ledgerDayKeys,
	pruneLedger,
	summarizeDays,
} from "./ledger.js";
import {
	balanceAppliesToRoute,
	listDeepSeekRoutes,
	probeBalance,
	resolveCredential,
	routeBaseUrl,
	truncateError,
} from "./probe.js";

/** How many trend days the overview serves. */
const TREND_DAYS = 30;

/** Ledger flush debounce: a burst of calls costs one write. */
const FLUSH_DEBOUNCE_MS = 3_000;

/** Provider probe cadence; the card reads a snapshot at its own 60 s pace. */
const DEFAULT_POLL_SEC = 60;

/** Ledger retention in Beijing days. */
const DEFAULT_RETAIN_DAYS = 180;

/** The display name the card shows for the DeepSeek family. */
const DISPLAY_NAME = "DeepSeek";

/**
 * Atomic JSON write through a unique temp file + fsync + rename. The temp name
 * is per-call so two overlapping flushes can never interleave into one temp
 * file, and the fsync closes the rename-lands-but-bytes-are-not-durable window.
 */
async function writeJsonAtomic(path, value) {
	const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		const handle = await open(temp, "w");
		try {
			await handle.writeFile(JSON.stringify(value, null, 1), "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temp, path);
	} catch (error) {
		await unlink(temp).catch(() => {});
		throw error;
	}
}

export class AccountGlanceService {
	/**
	 * @param ctx - host root context.
	 * @param options - `{ pollIntervalSec, retainDays }`, both optional.
	 */
	constructor(ctx, options = {}) {
		this.ctx = ctx;
		this.pollIntervalSec = typeof options.pollIntervalSec === "number" && Number.isFinite(options.pollIntervalSec)
			? Math.max(30, options.pollIntervalSec)
			: DEFAULT_POLL_SEC;
		this.retainDays = typeof options.retainDays === "number" && Number.isFinite(options.retainDays)
			? options.retainDays
			: DEFAULT_RETAIN_DAYS;

		const persistDir = join(dshHome(), "account-glance");
		this.persistDir = persistDir;
		this.ledgerPath = join(persistDir, "ledger.json");
		this.snapshotsPath = join(persistDir, "provider-snapshots.json");

		this.ledger = createLedgerDocument();
		this.snapshots = new Map();
		/** Per-live-session route attribution (WeakMap: disposed sessions age out). */
		this.sessionRoutes = new WeakMap();

		this.loaded = false;
		this.disposed = false;
		this.pollTimer = undefined;
		this.flushTimer = undefined;
		this.pollInFlight = false;
		this.pollPromise = undefined;
		this.flushChain = Promise.resolve();
		this.sessionListenerDisposer = undefined;
		this.lastPrune = undefined;
	}

	/** Subscribe to session usage, load persisted state, and start probing. */
	start() {
		// The profile's own holiday file is merged before the first clock read, so
		// a year the package does not know yet still bills the way the browser shows.
		loadHolidayOverride(this.persistDir);
		if (typeof this.ctx?.on === "function") {
			this.sessionListenerDisposer = this.ctx.on("session/event", (session, event) => this.onSessionEvent(session, event));
		}
		void this.loadPersisted();
		this.rearmPoll(2_000);
	}

	/**
	 * Stop every loop and flush what is in memory.
	 * @returns a promise for the final ledger write.
	 */
	stop() {
		this.disposed = true;
		if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
		if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
		this.pollTimer = undefined;
		this.flushTimer = undefined;
		try {
			this.sessionListenerDisposer?.();
		} catch {
			// The listener fiber is already gone during shutdown.
		}
		this.sessionListenerDisposer = undefined;
		return this.flushLedger().catch(() => {});
	}

	/* ---------------------------------------------------------------- *
	 * Overview
	 * ---------------------------------------------------------------- */

	/**
	 * Assemble the document the browser card reads: one row per probed
	 * provider route plus today's ledger totals.
	 * @returns the overview document.
	 */
	overview() {
		const todayKey = beijingDateKey(Date.now());
		const providers = [...this.snapshots.values()].map((snapshot) => ({ ...snapshot }));
		providers.sort((a, b) => Number(b.supported) - Number(a.supported) || String(a.displayName).localeCompare(String(b.displayName)));
		const dayKeys = ledgerDayKeys(this.ledger);
		const days = dayKeys.slice(-TREND_DAYS);
		return {
			updatedAt: Date.now(),
			providers,
			// The calendar travels with the overview so the card's clock cannot
			// disagree with the column this host priced the ledger in.
			billing: { holidays: holidayDates() },
			usage: {
				today: this.daySummary(todayKey),
				days: days.map((date) => ({ date, totals: this.daySummary(date).totals })),
			},
		};
	}

	/** One day's ledger summary. */
	daySummary(dateKey) {
		const summary = summarizeDays([this.ledger.days[dateKey] ?? {}]);
		return { date: dateKey, totals: summary.totals, providers: summary.providers };
	}

	/**
	 * Force one probe cycle now and answer with the fresh overview.
	 * @returns the overview document.
	 */
	async refresh() {
		await this.pollNow();
		return this.overview();
	}

	/* ---------------------------------------------------------------- *
	 * Session usage fold
	 * ---------------------------------------------------------------- */

	/** Fold one session event into the ledger, or drop it. */
	onSessionEvent(session, event) {
		try {
			const type = event?.type;
			if (type === "request/header") {
				const config = event.data?.header?.config;
				if (typeof config?.provider === "string" && config.provider !== "") {
					this.sessionRoutes.set(session, { provider: config.provider, model: config.model ?? "" });
				}
			} else if (type === "request/context") {
				const provider = event.data?.provider;
				if (typeof provider === "string" && provider !== "") {
					this.sessionRoutes.set(session, { provider, model: event.data?.model ?? "" });
				}
			} else if (type === "assistant/message") {
				const usage = event.data?.usage;
				if (usage === undefined || usage === null) return;
				const route = this.sessionRoutes.get(session);
				if (route === undefined || route.provider === "") return;
				const atMs = Date.now();
				foldUsage(this.ledger, atMs, route.provider, route.model || "unknown", this.totalsFrom(usage, route.provider, route.model || "unknown", atMs));
				this.scheduleFlush();
			}
		} catch {
			// A malformed event must never break the session loop.
		}
	}

	/**
	 * Normalize a provider usage report into the ledger bucket (one call). Only
	 * the DeepSeek official family is priced; other routes stay unpriced (cost
	 * 0), so a mixed ledger never sums two currencies.
	 */
	totalsFrom(usage, provider, model, atMs) {
		const totals = emptyTotals();
		totals.inputTokens = Number(usage.inputTokens) || 0;
		totals.outputTokens = Number(usage.outputTokens) || 0;
		totals.cacheReadTokens = Number(usage.cacheReadTokens) || 0;
		totals.cacheWriteTokens = Number(usage.cacheWriteTokens) || 0;
		totals.reasoningTokens = Number(usage.reasoningTokens) || 0;
		totals.calls = 1;
		if (isDeepSeekRoute(provider)) totals.cost = deepseekModelSpend(model, totals, atMs);
		return totals;
	}

	/* ---------------------------------------------------------------- *
	 * Poll loop
	 * ---------------------------------------------------------------- */

	/** Arm the next probe cycle. */
	rearmPoll(delayMs) {
		if (this.disposed) return;
		if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
		this.pollTimer = setTimeout(() => {
			this.pollTimer = undefined;
			void this.pollNow().finally(() => this.rearmPoll(this.pollIntervalSec * 1000));
		}, delayMs);
	}

	/**
	 * One poll cycle: prune, enumerate routes, resolve credentials, probe. A
	 * call while a cycle is already running joins that cycle instead of
	 * returning immediately, so a manual refresh always waits for real probes.
	 * @returns a promise for the cycle.
	 */
	pollNow() {
		if (this.pollInFlight) return this.pollPromise ?? Promise.resolve();
		if (this.disposed) return Promise.resolve();
		this.pollInFlight = true;
		const cycle = (async () => {
			try {
				this.pruneIfNeeded();
				const routes = listDeepSeekRoutes(this.ctx);
				const seen = new Set();
				for (const id of routes) {
					if (this.disposed) return;
					seen.add(id);
					await this.probeRoute(id);
				}
				for (const id of [...this.snapshots.keys()]) {
					if (!seen.has(id)) this.snapshots.delete(id);
				}
				if (this.disposed) return;
				await this.persistSnapshots();
			} finally {
				this.pollInFlight = false;
				this.pollPromise = undefined;
			}
		})();
		this.pollPromise = cycle;
		return cycle;
	}

	/** Probe one route and record its snapshot. Never throws. */
	async probeRoute(id) {
		const baseURL = routeBaseUrl(this.ctx, id);
		const credential = await resolveCredential(this.ctx, id).catch(() => ({ kind: "none" }));
		const previous = this.snapshots.get(id);
		const base = {
			provider: id,
			displayName: DISPLAY_NAME,
			credential: credential.kind,
			supported: true,
		};
		if (!balanceAppliesToRoute(baseURL)) {
			// The endpoint reports the official account only; a reseller-pointed
			// route must not print this account's money under its name.
			this.snapshots.set(id, { ...base, balanceSupported: false, ...(previous?.balance !== undefined ? { balance: previous.balance } : {}), updatedAt: Date.now() });
			return;
		}
		if (credential.key === undefined) {
			// Nothing to probe with: retained facts would never refresh again, so
			// the row resets instead of presenting stale money as current.
			this.snapshots.set(id, { ...base, balanceSupported: true, updatedAt: Date.now() });
			return;
		}
		try {
			const balance = await probeBalance(credential.key);
			this.snapshots.set(id, { ...base, balanceSupported: true, balance, updatedAt: Date.now() });
		} catch (error) {
			// A failed probe keeps the last good number but flags it.
			this.snapshots.set(id, {
				...base,
				balanceSupported: true,
				...(previous?.balance !== undefined ? { balance: previous.balance } : {}),
				error: truncateError(error instanceof Error ? error.message : String(error)),
				updatedAt: Date.now(),
			});
		}
	}

	/* ---------------------------------------------------------------- *
	 * Persistence
	 * ---------------------------------------------------------------- */

	/** Debounced ledger flush. */
	scheduleFlush() {
		if (this.flushTimer !== undefined || this.disposed) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			void this.flushLedger();
		}, FLUSH_DEBOUNCE_MS);
	}

	/**
	 * Queue one ledger flush behind the previous one, so two atomic writes can
	 * never run concurrently on the same path.
	 * @returns a promise for this flush.
	 */
	flushLedger() {
		const next = this.flushChain.then(() => this.writeLedgerOnce());
		this.flushChain = next.catch(() => {});
		return next;
	}

	async writeLedgerOnce() {
		// Never overwrite the persisted file before it has been loaded: a flush
		// racing the load window would clobber history with a partial document.
		if (!this.loaded) return;
		try {
			await mkdir(dirname(this.ledgerPath), { recursive: true });
			await writeJsonAtomic(this.ledgerPath, this.ledger);
		} catch {
			// Persistence failures degrade silently; the in-memory ledger keeps counting.
		}
	}

	/** Load the persisted ledger and provider snapshots, merging into memory. */
	async loadPersisted() {
		try {
			const [rawLedger, rawSnapshots] = await Promise.all([
				readFile(this.ledgerPath, "utf8").catch(() => undefined),
				readFile(this.snapshotsPath, "utf8").catch(() => undefined),
			]);
			if (rawLedger !== undefined) {
				const loaded = deserializeLedger(JSON.parse(rawLedger));
				// Merge into (never replace) the live document: folds that landed
				// during the read window must survive the load.
				for (const [dayKey, providers] of Object.entries(loaded.days)) {
					const atMs = Date.parse(dayKey + "T12:00:00Z");
					if (!Number.isFinite(atMs)) continue;
					for (const [provider, models] of Object.entries(providers)) {
						for (const [model, totals] of Object.entries(models)) foldUsage(this.ledger, atMs, provider, model, totals);
					}
				}
				this.pruneIfNeeded();
			}
			if (rawSnapshots !== undefined) {
				const parsed = JSON.parse(rawSnapshots);
				if (typeof parsed?.providers === "object" && parsed.providers !== null) {
					for (const [id, snapshot] of Object.entries(parsed.providers)) {
						if (typeof snapshot === "object" && snapshot !== null) this.snapshots.set(id, snapshot);
					}
				}
			}
		} catch {
			// A corrupt state file degrades to fresh, empty state.
		} finally {
			this.loaded = true;
		}
	}

	/** Persist the provider snapshots (balances and their errors). */
	async persistSnapshots() {
		if (!this.loaded) return;
		try {
			await mkdir(dirname(this.snapshotsPath), { recursive: true });
			await writeJsonAtomic(this.snapshotsPath, { version: 1, providers: Object.fromEntries(this.snapshots) });
		} catch {
			// Same silent degradation as the ledger.
		}
	}

	/**
	 * Prune days past retention. Runs at most once per Beijing day, so a
	 * long-lived process honors retention without a write per cycle.
	 */
	pruneIfNeeded() {
		const todayKey = beijingDateKey(Date.now());
		if (this.lastPrune?.dayKey === todayKey && this.lastPrune.retainDays === this.retainDays) return;
		const pruned = pruneLedger(this.ledger, todayKey, this.retainDays);
		this.lastPrune = { dayKey: todayKey, retainDays: this.retainDays };
		if (pruned > 0) this.scheduleFlush();
	}
}