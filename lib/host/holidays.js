/**
 * The Chinese statutory holiday calendar behind the peak / off-peak clock.
 *
 * The official schedule bills every Chinese public holiday as a whole off-peak
 * day, and the State Council announces the dates one year at a time (the 2026
 * notice is 国办发明电〔2025〕7号, published 2025-11-04; the 2027 one lands around
 * November 2026). Baking dates into the package would force a release every
 * year, so the built-in table is only a fallback: a profile can add the next
 * year itself by writing
 *
 *   <DSH_HOME>/account-glance/holidays.json
 *   { "holidays": ["2027-01-01", "2027-02-05"] }
 *
 * The file is additive by default; `{ "replace": true, "holidays": [...] }`
 * swaps the built-in table out instead (useful if a date in this file is ever
 * wrong). An unreadable or malformed file is ignored: a bad calendar must never
 * break the clock, it may only make it fall back to the weekday rule.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Dates of the built-in calendar, `YYYY-MM-DD`, Beijing time.
 *
 * 2026 is quoted from the State Council notice (国办发明电〔2025〕7号).
 *
 * 2027 is DERIVED, not quoted: that notice is not published yet (the 2026 one
 * landed 2025-11-04, so 2027 is due around November 2026). The statutory dates
 * are computed from the lunar calendar — 除夕 2027-02-06, 正月初一 02-07,
 * 端午 06-09, 中秋 09-15 — which totals the current 13 statutory days and was
 * verified against the known 2026 dates; the bridge days follow the 2025/2026
 * pattern. Swap them for the official dates through holidays.json when the
 * notice lands.
 */
export const BUILTIN_HOLIDAYS = [
	// ===== 2026 (official) =====
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

	// ===== 2027 (provisional — see the note above) =====
	// 元旦
	"2027-01-01", "2027-01-02", "2027-01-03",
	// 春节：除夕 2/6 起 8 天（2025/2026 口径）
	"2027-02-06", "2027-02-07", "2027-02-08", "2027-02-09",
	"2027-02-10", "2027-02-11", "2027-02-12", "2027-02-13",
	// 清明节（4/5 为清明，4/3-4/4 是周末）
	"2027-04-03", "2027-04-04", "2027-04-05",
	// 劳动节：5 天（2025/2026 口径）
	"2027-05-01", "2027-05-02", "2027-05-03", "2027-05-04", "2027-05-05",
	// 端午节：周三，按近年 3 天口径推断
	"2027-06-09", "2027-06-10", "2027-06-11",
	// 中秋节：周三，按近年 3 天口径推断
	"2027-09-15", "2027-09-16", "2027-09-17",
	// 国庆节：7 天（近年口径）
	"2027-10-01", "2027-10-02", "2027-10-03", "2027-10-04", "2027-10-05",
	"2027-10-06", "2027-10-07",
];

/** The name a profile's own calendar takes inside the data directory. */
export const HOLIDAY_OVERRIDE_FILE = "holidays.json";

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/u;
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

/** The calendar in effect: the built-in table plus any profile override. */
let effective = new Set(BUILTIN_HOLIDAYS);

/**
 * Keep only plausible date keys, deduplicated and sorted.
 * @param input - anything a caller may have parsed out of JSON.
 * @returns the usable `YYYY-MM-DD` keys, `[]` for unusable input.
 */
export function normalizeHolidayDates(input) {
	if (!Array.isArray(input)) return [];
	const kept = new Set();
	for (const value of input) {
		if (typeof value !== "string" || !DATE_KEY.test(value)) continue;
		const year = Number(value.slice(0, 4));
		if (year < MIN_YEAR || year > MAX_YEAR) continue;
		// Rejects impossible dates such as 2027-13-40.
		if (Number.isNaN(Date.parse(`${value}T00:00:00Z`))) continue;
		kept.add(value);
	}
	return [...kept].sort();
}

/**
 * The calendar in effect, sorted, as the card receives it from the host.
 * @returns date keys.
 */
export function holidayDates() {
	return [...effective].sort();
}

/**
 * Replace or extend the calendar in effect.
 * @param dates - candidate date keys.
 * @param replace - drop the current calendar first.
 */
export function setHolidays(dates, replace = false) {
	const next = new Set(replace ? [] : effective);
	for (const date of normalizeHolidayDates(dates)) next.add(date);
	effective = next;
}

/** Restore the built-in calendar. */
export function resetHolidays() {
	effective = new Set(BUILTIN_HOLIDAYS);
}

/**
 * Whether a Beijing date key is a public holiday.
 * @param dateKey - `YYYY-MM-DD` in Beijing time.
 * @returns true when the whole day bills off-peak.
 */
export function isHolidayDate(dateKey) {
	return effective.has(dateKey);
}

/**
 * Merge the profile's own holiday file into the calendar in effect.
 * @param dir - the plugin's data directory (`<DSH_HOME>/account-glance`).
 * @returns how many dates were applied, and why a file was ignored.
 */
export function loadHolidayOverride(dir) {
	const file = join(dir, HOLIDAY_OVERRIDE_FILE);
	if (!existsSync(file)) return { added: 0 };
	let document;
	try {
		document = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return { added: 0, error: `${HOLIDAY_OVERRIDE_FILE} is not readable JSON` };
	}
	const dates = normalizeHolidayDates(Array.isArray(document) ? document : document?.holidays);
	if (dates.length === 0) return { added: 0, error: `${HOLIDAY_OVERRIDE_FILE} names no usable date` };
	setHolidays(dates, document?.replace === true);
	return { added: dates.length };
}
