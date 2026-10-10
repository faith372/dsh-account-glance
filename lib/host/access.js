/**
 * Trust fence for the plugin's host routes.
 *
 * Derived from @linxin666/dsh-usage 0.4.4 (Apache-2.0,
 * https://github.com/zhu1090093659/dsh-web) — `shared/host/loopback.ts` and
 * `shared/host/pair-access.ts` (shipped as `src/host/loopback.ts` /
 * `src/host/pair-access.ts`). Changed: both fences live in one file here.
 *
 * Loopback (the desktop browser) always passes. A live paired-device cookie is
 * an additional allow path when remote-web-ui is loaded; without that service
 * the fence stays loopback-only, so an unpaired LAN browser keeps its 403. The
 * pairing lookup is deliberately structural (a string service key), so this
 * plugin takes no dependency on that plugin.
 */

/** IPv4 127/8 predicate (four decimal octets, first == 127). */
export function isIPv4Loopback(v4) {
	const parts = v4.split(".");
	return parts.length === 4
		&& parts[0] === "127"
		&& parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** Whether a socket remote address names the loopback range (127/8, ::1, IPv4-mapped). */
export function isLoopbackAddress(address) {
	if (address === undefined) return false;
	const normalized = address.toLowerCase();
	if (normalized === "::1") return true;
	if (normalized.startsWith("::ffff:")) return isIPv4Loopback(normalized.slice("::ffff:".length));
	return isIPv4Loopback(normalized);
}

/** Whether a normalized URL hostname names the loopback authority. */
export function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	return isIPv4Loopback(hostname);
}

/**
 * Request-level trust fence: a loopback socket address AND a loopback Host
 * header, plus browser same-origin markers. The socket address is
 * authoritative; X-Forwarded-For is never trusted.
 * @param request - the incoming HTTP request.
 * @returns true when the request provably came from the desktop browser.
 */
export function isLoopbackRequest(request) {
	const address = request?.socket?.remoteAddress;
	if (!isLoopbackAddress(address)) return false;
	const host = request?.headers?.host;
	if (typeof host !== "string") return false;
	let hostUrl;
	try {
		hostUrl = new URL("http://" + host);
	} catch {
		return false;
	}
	if (!isLoopbackHostname(hostUrl.hostname)) return false;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = request.headers.origin;
	if (origin === undefined) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}

/** Whether a value looks like the remote-web-ui pairing service. */
function isPairingAccess(value) {
	return value !== undefined
		&& value !== null
		&& typeof value.isPairedDevice === "function";
}

/**
 * Whether this request may read the overview or force a refresh.
 * @param ctx - host context; may expose the remote-web-ui pairing service.
 * @param request - the incoming HTTP request.
 * @returns true for loopback, or a live paired-device cookie.
 */
export function isAllowed(ctx, request) {
	if (isLoopbackRequest(request)) return true;
	let fromGet;
	try {
		fromGet = typeof ctx?.get === "function" ? ctx.get("remoteWebUiPairing", false) : undefined;
	} catch {
		fromGet = undefined;
	}
	const pairing = isPairingAccess(fromGet) ? fromGet : ctx?.remoteWebUiPairing;
	if (!isPairingAccess(pairing)) return false;
	try {
		return pairing.isPairedDevice(request) === true;
	} catch {
		return false;
	}
}