/**
 * dsh-account-glance — browser half.
 *
 * Seats one compact glance card in the sidebar foot, on the row directly above
 * the shell's Settings / personal-account row. It renders into the shell's own
 * `sidebar.footer.action` list slot (declared by ui-sidebar, and laid out inside
 * the foot's `footerActions` container, which stacks above `settingsArea`), so
 * the shell's own reconciliation owns the node instead of a detached DOM child.
 *
 * Three facts, one card:
 *  - the DeepSeek account balance, taken from dsh-usage's official provider
 *    balance probe (the `/user/balance` result behind the API key, resolved in
 *    the Host so the credential never reaches the browser). The `account` Remote
 *    namespace — the same call the Settings → 账号与余额 page makes — is consulted
 *    only when that probe carries no balance, so a signed-in-only setup still
 *    reads a number;
 *  - the current DeepSeek official peak / off-peak billing period — Beijing time
 *    weekday 09:00-12:00 and 14:00-18:00 are peak, every other hour is off-peak
 *    and billed at half price — with a live countdown to the next flip, and a
 *    manual refresh that forces a fresh probe cycle;
 *  - today's spend / tokens / calls, re-read from dsh-usage's loopback overview
 *    endpoint so the ledger keeps exactly one writer.
 *
 * This bundle also hides dsh-usage's own foot card, because that card occupies
 * the very same row and would otherwise duplicate the usage line.
 *
 * Hand-authored in the lazily-materialized CJS shape the client module system
 * serves (see @deepseek-ai/dsh-client-modules); `react` is the only external and
 * comes from the frozen platform module table.
 */

window.__ModuleLoader__.load({
	id: "dsh-account-glance",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		/** Slot entry id this card registers under, and its style/diagnostic key. */
		const ENTRY_ID = "account-glance";

		/** data-* attribute identifying the card node. */
		const CARD_ATTR = "data-dsh-account-glance";

		/** Injected <style> element id. */
		const STYLE_ID = "dsh-account-glance-style";

		/**
		 * dsh-usage's loopback overview. Document-relative on purpose: the GUI is
		 * served with `<base href="./">`, so a sub-path deployment resolves it
		 * against its entry directory instead of escaping to the origin root.
		 */
		const USAGE_OVERVIEW_PATH = "api/dsh-usage/overview";

		/**
		 * dsh-usage's forced probe cycle. The manual refresh posts here instead of
		 * re-reading the overview so the host re-probes the DeepSeek balance — the
		 * number behind the headline — rather than re-serving its last snapshot.
		 */
		const USAGE_REFRESH_PATH = "api/dsh-usage/refresh";

		/**
		 * One cadence for the whole card: the overview read is a local host
		 * snapshot and carries the provider balance probe with it, so the
		 * headline and the ledger line always describe the same cycle. 60 s
		 * matches dsh-usage's own provider probe interval (`pollIntervalSec`).
		 */
		const USAGE_POLL_MS = 60_000;

		/** The peak/off-peak countdown is computed, not fetched: one local tick. */
		const TICK_MS = 1_000;

		/** Hard ceiling for one HTTP call; a stalled host must not pile up requests. */
		const FETCH_TIMEOUT_MS = 15_000;

		/**
		 * Hard ceiling for one balance read. The Remote call is a Host round trip
		 * that can end at DeepSeek Platform; without a deadline a stalled call
		 * would pin the headline to its loading state forever.
		 */
		const BALANCE_TIMEOUT_MS = 15_000;

		/** The forced probe cycle re-queries every provider, so it gets a longer rope. */
		const REFRESH_TIMEOUT_MS = 25_000;

		/**
		 * Build version the account Remote carries; it only feeds the Platform's
		 * `x-client-version` telemetry header. A hand-authored bundle carries no
		 * build-time constant, so this stays pinned to the DSH cohort it targets.
		 */
		const CLIENT_VERSION = "0.2.0-rc.2";

		/** Attribute flag the layout owner sets on the frame while the rail is collapsed. */
		const COLLAPSED_ATTR = "[data-sidebar-collapsed]";

		/* ------------------------------------------------------------------ *
		 * DeepSeek official peak / off-peak clock
		 *
		 * Ported from the published price book used across this DSH cohort:
		 * Beijing time, Monday-Friday 09:00-12:00 and 14:00-18:00 are peak;
		 * every other hour (nights, weekends) is off-peak at half the peak
		 * price. Beijing is UTC+8 year-round, so a fixed shift is exact.
		 * ------------------------------------------------------------------ */

		/** One peak window in minutes-of-day, Beijing time. */
		const PEAK_WINDOWS = [
			{ from: 9 * 60, to: 12 * 60 },
			{ from: 14 * 60, to: 18 * 60 },
		];

		/** Beijing is UTC+8 with no DST. */
		const BEIJING_UTC_OFFSET_MS = 8 * 3_600_000;

		/**
		 * The DeepSeek billing period at `ms`, plus when it next flips.
		 * `boundaryMs` is the instant the current period ends — the window's
		 * close while peaking, the next window's open otherwise.
		 */
		function deepseekPeriodAt(ms) {
			const shifted = new Date(ms + BEIJING_UTC_OFFSET_MS);
			const weekday = shifted.getUTCDay();
			const minuteOfDay = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
			let current;
			if (weekday >= 1 && weekday <= 5) {
				for (const window of PEAK_WINDOWS) {
					if (minuteOfDay >= window.from && minuteOfDay < window.to) {
						current = window;
						break;
					}
				}
			}
			if (current !== undefined) {
				return {
					peak: true,
					boundaryMs:
						ms +
						(current.to - minuteOfDay) * 60_000 -
						shifted.getUTCSeconds() * 1_000 -
						shifted.getUTCMilliseconds(),
				};
			}
			// Next window start: later today (weekdays only), else the following
			// days' first morning window; the scan bound makes a malformed clock
			// terminate instead of looping.
			for (let dayOffset = 0; dayOffset < 8; dayOffset += 1) {
				const day = new Date(ms + BEIJING_UTC_OFFSET_MS + dayOffset * 86_400_000);
				if (day.getUTCDay() < 1 || day.getUTCDay() > 5) continue;
				const realDayStart =
					Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) -
					BEIJING_UTC_OFFSET_MS;
				for (const window of PEAK_WINDOWS) {
					if (dayOffset === 0 && window.from <= minuteOfDay) continue;
					return { peak: false, boundaryMs: realDayStart + window.from * 60_000 };
				}
			}
			// Unreachable (the scan covers a full week); a conservative answer.
			return { peak: false, boundaryMs: ms + 86_400_000 };
		}

		/* ------------------------------------------------------------------ *
		 * Copy
		 * ------------------------------------------------------------------ */

		/** Card copy, keyed by the two built-in locales. */
		const COPY = {
			zh: {
				title: "个人账户",
				loading: "读取中…",
				signedOut: "未登录",
				failed: "读取失败",
				noWallet: "无钱包",
				sourceProbe: "余额来源：DeepSeek API Key 余额探测",
				sourceAccount: "余额来源：设置 → 账号与余额接口",
				failureTitle: (reason) => "余额读取失败：" + reason,
				peak: "峰时 · 原价",
				offPeak: "谷时 · 5 折",
				toPeak: "距转峰",
				toOffPeak: "距转谷",
				second: (value) => value + " 秒",
				hourMinute: (hh, mm) => hh + " 小时 " + mm + " 分",
				minuteOnly: (mm) => mm + " 分",
				usageNone: "今日暂无用量",
				usageUnavailable: "今日用量不可用",
				usage: (cost, tokens, calls) => "今日 " + cost + " · " + tokens + " tokens · " + calls + " 次",
				usageNoCost: (tokens, calls) => "今日 " + tokens + " tokens · " + calls + " 次",
				calls: "次",
				refresh: "刷新",
				refreshing: "刷新中…",
			},
			en: {
				title: "Account",
				loading: "Loading…",
				signedOut: "Not signed in",
				failed: "Unavailable",
				noWallet: "No wallet",
				sourceProbe: "Balance source: DeepSeek API-key balance probe",
				sourceAccount: "Balance source: Settings → Account & balance endpoint",
				failureTitle: (reason) => "Balance read failed: " + reason,
				peak: "Peak · full price",
				offPeak: "Off-peak · 50% off",
				toPeak: "Peak in",
				toOffPeak: "Off-peak in",
				second: (value) => value + "s",
				hourMinute: (hh, mm) => hh + "h " + mm + "m",
				minuteOnly: (mm) => mm + "m",
				usageNone: "No usage today yet",
				usageUnavailable: "Today's usage unavailable",
				usage: (cost, tokens, calls) => "Today " + cost + " · " + tokens + " tokens · " + calls + " calls",
				usageNoCost: (tokens, calls) => "Today " + tokens + " tokens · " + calls + " calls",
				calls: "calls",
				refresh: "Refresh",
				refreshing: "Refreshing…",
			},
		};

		/** Pick the dictionary for one active locale id ('zh-CN', 'en-US', ...). */
		function copyFor(active) {
			return String(active ?? "").toLowerCase().indexOf("zh") === 0 ? COPY.zh : COPY.en;
		}

		/* ------------------------------------------------------------------ *
		 * Formatting
		 * ------------------------------------------------------------------ */

		/** Compact token count: 12345 -> 12.3k, 1234567 -> 1.23M. */
		function formatTokens(value) {
			if (!Number.isFinite(value) || value <= 0) return "0";
			if (value < 1_000) return String(value);
			if (value < 1_000_000) return trimNumber(value / 1_000) + "k";
			if (value < 1_000_000_000) return trimNumber(value / 1_000_000) + "M";
			return trimNumber(value / 1_000_000_000) + "B";
		}

		function trimNumber(value) {
			return value >= 100
				? String(Math.round(value))
				: value.toFixed(value >= 10 ? 1 : 2).replace(/\.?0+$/, "");
		}

		/** `¥11.74` / `$3.20` / `EUR 4.00`. */
		function formatMoney(currency, amount) {
			const code = String(currency ?? "").toUpperCase();
			const text = String(amount ?? "");
			if (code === "CNY") return "¥" + text;
			if (code === "USD") return "$" + text;
			return (code === "" ? "" : code + " ") + text;
		}

		/** Countdown to the next period flip, rounded up to the displayed unit. */
		function formatRemaining(ms, copy) {
			if (ms < 60_000) return copy.second(Math.max(1, Math.ceil(ms / 1_000)));
			const total = Math.ceil(ms / 60_000);
			const hh = Math.floor(total / 60);
			const mm = total % 60;
			return hh > 0 ? copy.hourMinute(hh, mm) : copy.minuteOnly(mm);
		}

		/* ------------------------------------------------------------------ *
		 * Data
		 * ------------------------------------------------------------------ */

		/**
		 * Request identity for one account call. The Host derives its Platform
		 * request headers from exactly these three fields; the locale is the
		 * active UI language, which the Host reduces to the wire locale.
		 */
		function accountMetadata(ctx) {
			let active = "zh-CN";
			try {
				active = ctx.locale.getSnapshot().active ?? active;
			} catch {
				// A locale service that is not up yet only costs the header value.
			}
			return {
				version: CLIENT_VERSION,
				locale: String(active),
				timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
			};
		}

		/**
		 * Unwrap one Remote call. The client Remote layer answers with an
		 * `{ ok, value }` outcome, but a bare value is accepted too so the card
		 * survives a protocol variant instead of rendering an error.
		 */
		function unwrapOutcome(outcome) {
			if (outcome !== null && typeof outcome === "object" && "ok" in outcome) {
				return outcome.ok ? outcome.value : null;
			}
			return outcome === undefined ? null : outcome;
		}

		/** Reject `promise` once `ms` elapse, so a stalled Remote call cannot hang the card. */
		function withDeadline(promise, ms, label) {
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(label + " timed out after " + ms + "ms")), ms);
				promise.then(
					(value) => {
						clearTimeout(timer);
						resolve(value);
					},
					(error) => {
						clearTimeout(timer);
						reject(error);
					},
				);
			});
		}

		/** One-line reason for a degraded read, carried into the headline tooltip. */
		function reasonOf(error) {
			if (error === null || error === undefined) return "unknown error";
			return error instanceof Error ? error.message : String(error);
		}

		/**
		 * Read the signed-in DeepSeek account's recharge wallets.
		 * @returns `{ kind, reason?, wallets, bonusWallets }`; `kind` is one of
		 *   `ready` | `signed-out` | `failed` | `unavailable`. It never rejects and
		 *   never stays pending past {@link BALANCE_TIMEOUT_MS}.
		 */
		async function readAccountBalance(ctx) {
			try {
				const remote = ctx.remote;
				const account = remote === undefined || remote === null ? undefined : remote.account;
				if (account === undefined || typeof account.getBalance !== "function") {
					return { kind: "unavailable", reason: "no account Remote", wallets: [], bonusWallets: [] };
				}
				const value = unwrapOutcome(
					await withDeadline(account.getBalance(accountMetadata(ctx)), BALANCE_TIMEOUT_MS, "account balance"),
				);
				if (value === null || value === undefined) {
					return { kind: "signed-out", wallets: [], bonusWallets: [] };
				}
				if (value.status === "ready") {
					return {
						kind: "ready",
						wallets: Array.isArray(value.value) ? value.value : [],
						bonusWallets: Array.isArray(value.bonusWallets) ? value.bonusWallets : [],
					};
				}
				return { kind: "failed", reason: "account service reported " + String(value.status), wallets: [], bonusWallets: [] };
			} catch (error) {
				return { kind: "failed", reason: reasonOf(error), wallets: [], bonusWallets: [] };
			}
		}

		/**
		 * Read today's ledger totals from dsh-usage's loopback overview. A 404
		 * means that plugin (or its route) is off: `unavailable`, not an error,
		 * so the card drops the line instead of pinning a failure to the foot.
		 * @param force - post to the refresh route so the host runs a probe cycle.
		 * @returns `{ status, today, probe }` where `probe` is the official
		 *   DeepSeek provider balance probe — the card's primary balance source.
		 */
		async function readUsage(force) {
			try {
				const response = force
					? await fetch(USAGE_REFRESH_PATH, {
							method: "POST",
							signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
						})
					: await fetch(USAGE_OVERVIEW_PATH, {
							signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
						});
				if (!response.ok) {
					return { status: response.status === 404 ? "unavailable" : "failed", today: null, probe: null };
				}
				const document = await response.json();
				const today = document?.usage?.today?.totals ?? null;
				const providers = Array.isArray(document?.providers) ? document.providers : [];
				let probe = null;
				for (const row of providers) {
					if (row?.provider !== "deepseek-official" && row?.provider !== "deepseek") continue;
					if (row.balance === undefined || row.balance === null) continue;
					probe = row.balance;
					break;
				}
				return { status: "ready", today, probe };
			} catch {
				return { status: "failed", today: null, probe: null };
			}
		}

		/**
		 * Resolve the headline balance, probe first.
		 *
		 * The API-key probe reports the same DeepSeek account and is the source
		 * that actually answers on this deployment, so it is authoritative; the
		 * account Remote is only consulted when the probe carries no balance, so
		 * a signed-in-only setup still reads a number. Never rejects, and never
		 * stays pending past {@link BALANCE_TIMEOUT_MS}.
		 * @param ctx - client root context.
		 * @param probe - the provider balance fact from {@link readUsage}.
		 * @returns `{ kind, currency?, amount?, source?, reason? }` with `kind`
		 *   one of `ready` | `empty` | `signed-out` | `failed`.
		 */
		async function resolveBalance(ctx, probe) {
			if (probe !== null && probe !== undefined && probe.totalBalance !== undefined) {
				return { kind: "ready", currency: probe.currency, amount: probe.totalBalance, source: "probe" };
			}
			const account = await readAccountBalance(ctx);
			if (account.kind === "ready") {
				const wallet = headlineWallet(account.wallets, account.bonusWallets);
				if (wallet === undefined) return { kind: "empty" };
				return { kind: "ready", currency: wallet.currency, amount: wallet.balance, source: "account" };
			}
			if (account.kind === "signed-out") return { kind: "signed-out" };
			return { kind: "failed", reason: account.reason };
		}

		/* ------------------------------------------------------------------ *
		 * Store
		 * ------------------------------------------------------------------ */

		/** A minimal external store: one immutable snapshot plus React subscribers. */
		function createStore() {
			let snapshot = {
				balance: { kind: "loading" },
				usageStatus: "loading",
				today: null,
			};
			const listeners = new Set();
			return {
				getSnapshot: () => snapshot,
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				set(patch) {
					let changed = false;
					for (const key of Object.keys(patch)) {
						if (patch[key] !== snapshot[key]) {
							changed = true;
							break;
						}
					}
					if (!changed) return;
					snapshot = Object.assign({}, snapshot, patch);
					for (const listener of Array.from(listeners)) {
						try {
							listener();
						} catch {
							// One broken subscriber must not stop the others.
						}
					}
				},
			};
		}

		/* ------------------------------------------------------------------ *
		 * View
		 * ------------------------------------------------------------------ */

		/** The wallet the headline shows: CNY first, then USD, then whatever exists. */
		function headlineWallet(wallets, bonusWallets) {
			const all = [];
			for (const wallet of wallets) all.push(wallet);
			for (const wallet of bonusWallets) all.push(wallet);
			for (const preferred of ["CNY", "USD"]) {
				for (const wallet of all) {
					if (String(wallet?.currency ?? "").toUpperCase() === preferred) return wallet;
				}
			}
			return all.length > 0 ? all[0] : undefined;
		}

		/** Small wallet glyph beside the card title. */
		function WalletIcon() {
			return h(
				"svg",
				{
					viewBox: "0 0 16 16",
					width: 14,
					height: 14,
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.3,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true",
				},
				h("path", { d: "M2.5 5.5A1.6 1.6 0 0 1 4.1 3.9h7.2" }),
				h("rect", { x: 2.5, y: 5, width: 11, height: 7.6, rx: 1.7 }),
				h("circle", { cx: 11.2, cy: 8.8, r: 0.85, fill: "currentColor", stroke: "none" }),
			);
		}

		/** Circular-arrow glyph for the manual refresh control. */
		function RefreshIcon() {
			return h(
				"svg",
				{
					viewBox: "0 0 24 24",
					width: 14,
					height: 14,
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 2,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true",
				},
				h("path", { d: "M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" }),
				h("path", { d: "M21 3v5h-5" }),
			);
		}

		/** Total tokens of a ledger bucket (billed input + output). */
		function totalTokens(totals) {
			return (
				(totals.inputTokens ?? 0) +
				(totals.cacheReadTokens ?? 0) +
				(totals.cacheWriteTokens ?? 0) +
				(totals.outputTokens ?? 0)
			);
		}

		/** The one card: balance headline, the peak/off-peak state, today's usage. */
		function AccountGlanceCard(props) {
			const store = props.store;
			const locale = props.locale;
			const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot);

			// Locale switches re-render the copy without re-registering the entry.
			const [, bump] = React.useState(0);
			React.useEffect(() => {
				try {
					return locale.subscribe(() => bump((count) => count + 1));
				} catch {
					return undefined;
				}
			}, [locale]);

			// The countdown ticks locally; nothing is refetched for it.
			const [now, setNow] = React.useState(() => Date.now());
			React.useEffect(() => {
				const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
				return () => window.clearInterval(timer);
			}, []);

			// Manual refresh: local to this card, so the cadence loops stay quiet.
			const [busy, setBusy] = React.useState(false);
			const refreshNow = () => {
				if (busy || typeof props.refresh !== "function") return;
				setBusy(true);
				Promise.resolve()
					.then(() => props.refresh())
					.catch(() => {
						// A failed refresh keeps the last values; the next poll retries.
					})
					.then(() => setBusy(false));
			};

			let active = "";
			try {
				active = locale.getSnapshot().active ?? "";
			} catch {
				// Falls through to the English dictionary.
			}
			const copy = copyFor(active);

			const balance = state.balance;
			let balanceText;
			let balanceTitle;
			if (balance.kind === "ready") {
				balanceText = formatMoney(balance.currency, balance.amount);
				// The source is one hover away instead of a mark on the number.
				balanceTitle = balance.source === "account" ? copy.sourceAccount : copy.sourceProbe;
			} else if (balance.kind === "loading") {
				balanceText = copy.loading;
			} else if (balance.kind === "empty") {
				balanceText = copy.noWallet;
			} else {
				balanceText = balance.kind === "signed-out" ? copy.signedOut : copy.failed;
				if (balance.reason !== undefined) balanceTitle = copy.failureTitle(balance.reason);
			}

			const period = deepseekPeriodAt(now);
			const remaining = formatRemaining(period.boundaryMs - now, copy);
			const badgeText = period.peak ? copy.peak : copy.offPeak;
			const countdownText = (period.peak ? copy.toOffPeak : copy.toPeak) + " " + remaining;

			let usageText;
			if (state.usageStatus === "loading") {
				usageText = copy.loading;
			} else if (state.usageStatus !== "ready") {
				usageText = copy.usageUnavailable;
			} else if (state.today === null || (state.today.calls ?? 0) === 0) {
				usageText = copy.usageNone;
			} else {
				const tokens = formatTokens(totalTokens(state.today));
				const calls = String(state.today.calls);
				// Coerced: a host that ships the cost as a decimal string must not
				// take the whole card down on `.toFixed`.
				const cost = Number(state.today.cost ?? 0);
				usageText =
					Number.isFinite(cost) && cost > 0
						? copy.usage("¥" + cost.toFixed(2), tokens, calls)
						: copy.usageNoCost(tokens, calls);
			}

			return h(
				"div",
				{ [CARD_ATTR]: "", className: "dsag-card" },
				h(
					"div",
					{ className: "dsag-head" },
					h("span", { className: "dsag-title" }, h(WalletIcon), copy.title),
					h("span", { className: "dsag-value", title: balanceTitle }, balanceText),
				),
				h(
					"div",
					{ className: "dsag-line" },
					h(
						"span",
						{ className: period.peak ? "dsag-badge dsag-peak" : "dsag-badge dsag-off" },
						badgeText,
					),
					h("span", { className: "dsag-dim", "data-dsh-part": "countdown" }, countdownText),
				),
				h(
					"div",
					{ className: "dsag-line dsag-foot" },
					h("span", { className: "dsag-dim", "data-dsh-part": "usage" }, usageText),
					h(
						"button",
						{
							type: "button",
							className: "dsag-refresh",
							"data-dsh-part": "refresh",
							"data-busy": busy ? "true" : undefined,
							disabled: busy,
							"aria-label": busy ? copy.refreshing : copy.refresh,
							title: busy ? copy.refreshing : copy.refresh,
							onClick: refreshNow,
						},
						h(RefreshIcon),
					),
				),
			);
		}

		/* ------------------------------------------------------------------ *
		 * Styles
		 * ------------------------------------------------------------------ */

		/**
		 * Card styling, built from the live theme tokens so it follows light/dark.
		 * The `footerActions` rule is the one shell-level tweak: that container is
		 * a single non-wrapping flex row, so the card claims a full row of its own
		 * and the shell's other foot actions keep the row above it.
		 */
		const STYLE_TEXT = [
			'[class*="footerActions"]{flex-wrap:wrap}',
			// The shell renders list-slot entries without a wrapper element, so the
			// card is a direct flex child; the :has() twin keeps the same geometry
			// if a future shell wraps entries.
			'[class*="footerActions"] > *:has([data-dsh-account-glance]){flex:1 1 100%;width:100%;min-width:0}',
			'[data-dsh-account-glance]{box-sizing:border-box;flex:1 1 100%;width:100%;min-width:0;',
			"margin:2px 0 4px;padding:8px;border-radius:12px;",
			"background:color-mix(in srgb, currentColor 4%, transparent);color:inherit;",
			"font-size:12px;line-height:1.35}",
			'[data-dsh-account-glance] .dsag-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}',
			'[data-dsh-account-glance] .dsag-title{display:inline-flex;align-items:center;gap:6px;min-width:0;opacity:.65;white-space:nowrap}',
			'[data-dsh-account-glance] .dsag-title svg{display:block;flex:none}',
			'[data-dsh-account-glance] .dsag-value{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}',
			'[data-dsh-account-glance] .dsag-line{display:flex;align-items:center;gap:6px;margin-top:4px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden}',
			'[data-dsh-account-glance] .dsag-dim{font-size:11px;opacity:.7}',
			// Bottom row: the ledger text takes the room, the refresh control sits
			// in the card's bottom-right corner.
			'[data-dsh-account-glance] .dsag-foot{gap:4px}',
			'[data-dsh-account-glance] .dsag-foot .dsag-dim{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}',
			'[data-dsh-account-glance] .dsag-refresh{appearance:none;flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:none;border-radius:6px;background:transparent;color:inherit;opacity:.55;cursor:pointer;transition:opacity 120ms ease,background-color 120ms ease}',
			'[data-dsh-account-glance] .dsag-refresh:hover{opacity:1;background:color-mix(in srgb, currentColor 10%, transparent)}',
			'[data-dsh-account-glance] .dsag-refresh:focus-visible{outline:none;box-shadow:0 0 0 2px color-mix(in srgb, currentColor 45%, transparent)}',
			'[data-dsh-account-glance] .dsag-refresh[disabled]{cursor:default;opacity:.4}',
			'[data-dsh-account-glance] .dsag-refresh svg{display:block}',
			'[data-dsh-account-glance] .dsag-refresh[data-busy="true"] svg{animation:dsag-spin 900ms linear infinite}',
			"@keyframes dsag-spin{to{transform:rotate(360deg)}}",
			"@media (prefers-reduced-motion: reduce){[data-dsh-account-glance] .dsag-refresh[data-busy=\"true\"] svg{animation:none}}",
			'[data-dsh-account-glance] .dsag-badge{flex:none;padding:1px 6px;border-radius:999px;font-size:11px;font-weight:500}',
			'[data-dsh-account-glance] .dsag-peak{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent)}',
			'[data-dsh-account-glance] .dsag-off{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)}',
			// The 56px rail keeps no room for a block: hide the card with the column.
			COLLAPSED_ATTR + " [data-dsh-account-glance]{display:none !important}",
			// dsh-usage seats its own glance on this exact row; this card owns it now.
			'[data-dsh-plugin="usage"][data-dsh-part="foot-card"]{display:none !important}',
		].join("");

		/**
		 * Install this instance's stylesheet; returns its disposer. An element
		 * left behind by a previous instance (an HMR reload whose teardown lands
		 * after the new apply) is dropped first, so the surviving instance always
		 * owns exactly one live sheet.
		 */
		function installStyles() {
			if (typeof document === "undefined") return () => {};
			const stale = document.getElementById(STYLE_ID);
			if (stale !== null) stale.remove();
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = STYLE_TEXT;
			(document.head ?? document.documentElement).appendChild(style);
			return () => {
				style.remove();
			};
		}

		/* ------------------------------------------------------------------ *
		 * Sources
		 * ------------------------------------------------------------------ */

		/**
		 * Keep the store fresh on one cadence, paused while the tab is hidden (the
		 * foot is permanently mounted, so an unguarded loop would poll a
		 * background page forever). The same closure exposes the card's manual
		 * refresh, which bypasses the cadence and forces a host probe cycle.
		 * @returns `{ stop, refresh }`; `refresh` settles once the cycle has.
		 */
		function startSources(ctx, store) {
			let timer;
			let stopped = false;

			const load = async (force) => {
				const read = await readUsage(force);
				const balance = await resolveBalance(ctx, read.probe);
				if (stopped) return;
				store.set({ balance, usageStatus: read.status, today: read.today });
			};

			const start = () => {
				if (stopped || timer !== undefined) return;
				void load(false);
				timer = window.setInterval(() => void load(false), USAGE_POLL_MS);
			};
			const pause = () => {
				if (timer !== undefined) window.clearInterval(timer);
				timer = undefined;
			};
			const onVisibility = () => {
				if (document.visibilityState === "visible") start();
				else pause();
			};

			if (document.visibilityState === "visible") start();
			document.addEventListener("visibilitychange", onVisibility);

			return {
				/** The manual refresh: force the probe cycle and re-resolve. */
				refresh: async () => {
					if (stopped) return;
					await load(true);
				},
				stop: () => {
					stopped = true;
					pause();
					document.removeEventListener("visibilitychange", onVisibility);
				},
			};
		}

		/* ------------------------------------------------------------------ *
		 * Plugin body
		 * ------------------------------------------------------------------ */

		exports.inject = ["slots", "locale", "remote"];

		/**
		 * Client plugin body: install the stylesheet, seed the card's store, start
		 * its poll loop, and claim the sidebar foot row above Settings.
		 * @param ctx - client root context.
		 */
		exports.apply = function apply(ctx) {
			const disposeStyles = installStyles();
			const store = createStore();
			const sources = startSources(ctx, store);

			const face = () => ({ store, locale: ctx.locale, refresh: sources.refresh });

			ctx.slots.inject("sidebar.footer.action", () => {
				try {
					const unregister = ctx.slots.register(
						{
							name: "sidebar.footer.action",
							id: ENTRY_ID,
							// Last in the fold: the wrapped card keeps the row directly
							// above the shell's Settings / account row.
							order: 50,
							inject: face,
						},
						AccountGlanceCard,
					);
					return () => {
						unregister();
					};
				} catch {
					// A shell without this seat leaves the plugin inert, not broken.
					return () => {};
				}
			});

			ctx.effect(
				() => () => {
					sources.stop();
					disposeStyles();
				},
				"account-glance: sidebar foot card lifetime",
			);
		};

		return module.exports;
	},
});
