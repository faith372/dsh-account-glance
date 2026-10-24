/**
 * DeepSeek official peak / off-peak pricing and the clock behind the card's
 * second line.
 *
 * Derived from @linxin666/dsh-usage 0.4.4 (Apache-2.0,
 * https://github.com/zhu1090093659/dsh-web) — `src/core/pricing.ts`. Changed:
 * the ledger day key is derived from the same Beijing clock (upstream buckets
 * by host-local date, which can disagree with the billing column on a host
 * outside UTC+8), and `isDeepSeekRoute` replaces the whole adapter registry.
 *
 * Policy (api-docs.deepseek.com pricing page): peak hours are Beijing time
 * Monday-Friday 09:00-12:00 and 14:00-18:00; every other hour — nights,
 * weekends, and every Chinese statutory public holiday in full — is off-peak
 * and billed at half the peak price. All prices are CNY per million tokens.
 */

/** One peak window in minutes-of-day, Beijing time. */
const PEAK_WINDOWS = [
	{ from: 9 * 60, to: 12 * 60 },
	{ from: 14 * 60, to: 18 * 60 },
];

/** Beijing is UTC+8 year-round (no DST), so a fixed shift is exact. */
const BEIJING_UTC_OFFSET_MS = 8 * 3_600_000;

/**
 * Chinese statutory public holidays — the days off announced each year by the
 * State Council — as Beijing dates. The official schedule bills these whole
 * days at the off-peak rate, so the clock has to know them; dates outside a
 * covered year fall back to the plain weekday rule.
 *
 * Maintained through 2026 (国办发明电〔2025〕7号). Extend the table when the
 * next year's notice is published; make-up workdays need no entry because
 * weekends are off-peak either way.
 */
const PUBLIC_HOLIDAYS = new Set([
	// 元旦
	"2026-01-01", "2026-01-02", "2026-01-03",
	// 春节
	"2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19",
	"2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
	// 清明节
	"2026-04-04", "2026-04-05", "2026-04-06",
	// 劳动节
	"2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
	// 端午节
	"2026-06-19", "2026-06-20", "2026-06-21",
	// 中秋节
	"2026-09-25", "2026-09-26", "2026-09-27",
	// 国庆节
	"2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05",
	"2026-10-06", "2026-10-07",
]);

/** One price row in CNY per million tokens, split by billing period. */
const FLASH_PRICE = {
	cacheHit: { offPeak: 0.02, peak: 0.04 },
	inputMiss: { offPeak: 1.0, peak: 2.0 },
	output: { offPeak: 4.0, peak: 8.0 },
};

/** `deepseek-v4-pro`: still sold on its own published row, never folded into flash. */
const PRO_PRICE = {
	cacheHit: { offPeak: 0.15, peak: 0.3 },
	inputMiss: { offPeak: 4.5, peak: 9.0 },
	output: { offPeak: 13.5, peak: 27.0 },
};

/** The official DeepSeek API origin: the only account its balance endpoint reports. */
export const DEEPSEEK_API_ORIGIN = "https://api.deepseek.com";

/**
 * Route keys that belong to the DeepSeek official family: `deepseek-official`
 * is the live llm-deepseek route, `deepseek` the configurable-catalog alias
 * that resolves the same credential.
 */
const DEEPSEEK_ROUTE_IDS = ["deepseek", "deepseek-official"];

/** Whether a provider route key belongs to the DeepSeek official family. */
export function isDeepSeekRoute(provider) {
	return DEEPSEEK_ROUTE_IDS.includes(provider);
}

/** The peak window containing a minute-of-day, if any. */
function withinWindow(minuteOfDay) {
	return PEAK_WINDOWS.find((window) => minuteOfDay >= window.from && minuteOfDay < window.to);
}

/**
 * The DeepSeek billing period at `ms`, plus when it next flips. The clock is
 * Beijing time regardless of the host timezone. `boundaryMs` is the instant the
 * current period ends — the window's close while peaking, the next window's
 * open otherwise.
 * @param ms - epoch milliseconds.
 * @returns `{ peak, boundaryMs }`.
 */
export function deepseekPeriodAt(ms) {
	const shifted = new Date(ms + BEIJING_UTC_OFFSET_MS);
	const weekday = shifted.getUTCDay();
	const minuteOfDay = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
	const current = !isPublicHoliday(ms) && weekday >= 1 && weekday <= 5 ? withinWindow(minuteOfDay) : undefined;
	if (current !== undefined) {
		return {
			peak: true,
			boundaryMs: ms + (current.to - minuteOfDay) * 60_000 - shifted.getUTCSeconds() * 1000 - shifted.getUTCMilliseconds(),
		};
	}
	// Next window start: later today (weekdays only), else the following days'
	// first morning window, skipping weekends and public holidays. The 21-day
	// bound covers the longest holiday break and terminates on a malformed clock.
	for (let dayOffset = 0; dayOffset < 21; dayOffset += 1) {
		const day = new Date(ms + BEIJING_UTC_OFFSET_MS + dayOffset * 86_400_000);
		if (day.getUTCDay() < 1 || day.getUTCDay() > 5) continue;
		const realDayStart = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) - BEIJING_UTC_OFFSET_MS;
		if (isPublicHoliday(realDayStart)) continue;
		for (const window of PEAK_WINDOWS) {
			if (dayOffset === 0 && window.from <= minuteOfDay) continue;
			return { peak: false, boundaryMs: realDayStart + window.from * 60_000 };
		}
	}
	return { peak: false, boundaryMs: ms + 86_400_000 };
}

/**
 * The Beijing calendar date (`YYYY-MM-DD`) of an instant. The ledger uses this
 * so a day's cost column and the day it is filed under always agree with the
 * billing clock the card shows.
 * @param ms - epoch milliseconds.
 * @returns the date key.
 */
export function beijingDateKey(ms) {
	const shifted = new Date(ms + BEIJING_UTC_OFFSET_MS);
	const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
	const day = String(shifted.getUTCDate()).padStart(2, "0");
	return `${shifted.getUTCFullYear()}-${month}-${day}`;
}

/**
 * Whether an instant falls on a Chinese statutory public holiday, where the
 * whole day is billed at the off-peak rate.
 * @param ms - epoch milliseconds.
 * @returns true on a holiday date.
 */
export function isPublicHoliday(ms) {
	return PUBLIC_HOLIDAYS.has(beijingDateKey(ms));
}

/** The price row for a model id; unknown ids take the flash-class row. */
function priceFor(model) {
	return model.includes("v4-pro") ? PRO_PRICE : FLASH_PRICE;
}

/**
 * Estimate one call's DeepSeek spend in CNY from its token totals, priced in the
 * billing period at `atMs`. Uncatalogued model ids take the flash-class row.
 * @param model - the provider-owned model id.
 * @param totals - the token totals of one call.
 * @param atMs - the fold instant.
 * @returns CNY, rounded to micro-CNY.
 */
export function deepseekModelSpend(model, totals, atMs) {
	const price = priceFor(model, atMs);
	const period = deepseekPeriodAt(atMs);
	const column = period.peak ? "peak" : "offPeak";
	const spend = (totals.cacheReadTokens * price.cacheHit[column]
		+ (totals.inputTokens + totals.cacheWriteTokens) * price.inputMiss[column]
		+ totals.outputTokens * price.output[column]) / 1_000_000;
	return Math.round(spend * 1e6) / 1e6;
}