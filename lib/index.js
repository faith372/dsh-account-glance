/**
 * dsh-account-glance — host half.
 *
 * The plugin's host half owns the two data sources the sidebar card renders:
 * it folds live DSH session usage into a small persistent ledger (today's
 * cost / tokens / calls) and probes the DeepSeek official account balance with
 * the host-held API key. Both are served over loopback-only routes
 * (`api/dsh-account-glance/overview`, `.../refresh`); the browser half never
 * touches a credential.
 *
 * Derived from @linxin666/dsh-usage 0.4.4 (Apache-2.0,
 * https://github.com/zhu1090093659/dsh-web) — see `THIRD-PARTY-NOTICES.md`.
 */

import { AccountGlanceService } from "./host/service.js";
import { makeOverviewRoute, makeRefreshRoute } from "./host/routes.js";

export const name = "dsh-account-glance";

/** The webserver must be present for the browser half to read the overview. */
export const inject = ["webServer"];

/**
 * Host body: start one service per activation and register its two routes; the
 * returned disposer unregisters them and flushes the ledger.
 * @param ctx - host root context.
 */
export function apply(ctx) {
	const mount = () => {
		const service = new AccountGlanceService(ctx);
		service.start();
		const disposers = [];
		if (ctx?.webServer !== undefined && typeof ctx.webServer.register === "function") {
			for (const route of [makeOverviewRoute(ctx, service), makeRefreshRoute(ctx, service)]) {
				try {
					disposers.push(ctx.webServer.register(route));
				} catch {
					// A route this host refuses must not take the whole card down.
				}
			}
		}
		return () => {
			for (const dispose of disposers) {
				try {
					dispose();
				} catch {
					// Route fiber already gone during shutdown.
				}
			}
			void service.stop();
		};
	};
	if (typeof ctx?.effect === "function") ctx.effect(mount, "dsh-account-glance: runtime");
	else mount();
}