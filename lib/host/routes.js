/**
 * The plugin's host routes: the overview the browser card reads, and the
 * manual refresh that forces one probe cycle.
 *
 * Derived from @linxin666/dsh-usage 0.4.4 (Apache-2.0,
 * https://github.com/zhu1090093659/dsh-web) — `src/host/routes.ts`. Changed:
 * only this plugin's own route prefix and trust fence are wired.
 */

import { isAllowed } from "./access.js";
import { writeJson } from "./http.js";

/** This plugin's host route prefix. */
export const API_PREFIX = "/api/dsh-account-glance";

/**
 * Overview route: provider balances plus today's ledger totals. Personal
 * account data behind the trust fence — loopback always passes, and a live
 * paired-device cookie passes too when remote-web-ui is loaded.
 * @param ctx - host context; may expose the remote-web-ui pairing service.
 * @param service - the account glance service.
 * @returns the route.
 */
export function makeOverviewRoute(ctx, service) {
	return {
		kind: "exact",
		path: API_PREFIX + "/overview",
		handler: async (req, res) => {
			if (!isAllowed(ctx, req)) {
				writeJson(res, 403, { ok: false, error: "forbidden: loopback-only" });
				return;
			}
			writeJson(res, 200, service.overview(), { "cache-control": "no-store" });
		},
	};
}

/**
 * Manual refresh: forces one probe cycle now and answers with the fresh
 * overview. Same trust fence as the overview route.
 * @param ctx - host context; may expose the remote-web-ui pairing service.
 * @param service - the account glance service.
 * @returns the route.
 */
export function makeRefreshRoute(ctx, service) {
	return {
		kind: "exact",
		path: API_PREFIX + "/refresh",
		handler: async (req, res) => {
			if (!isAllowed(ctx, req)) {
				writeJson(res, 403, { ok: false, error: "forbidden: loopback-only" });
				return;
			}
			if (req.method !== "POST") {
				writeJson(res, 405, { ok: false, error: "method not allowed" });
				return;
			}
			try {
				await service.refresh();
			} catch (error) {
				writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : "refresh failed" });
				return;
			}
			writeJson(res, 200, service.overview(), { "cache-control": "no-store" });
		},
	};
}