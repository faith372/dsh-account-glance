/**
 * Shared HTTP helpers for the host routes.
 *
 * Derived from @linxin666/dsh-usage 0.4.4 (Apache-2.0,
 * https://github.com/zhu1090093659/dsh-web) — `shared/host/http.ts` (shipped as
 * `src/host/http.ts`). Changed: only the JSON writer and the outbound request
 * helper this plugin needs are kept.
 */

/** Family-default JSON response headers. */
const JSON_HEADERS = {
	"content-type": "application/json; charset=utf-8",
	"referrer-policy": "no-referrer",
};

/**
 * Write one JSON response. Default headers are the family defaults; caller
 * headers are appended or override them.
 * @param res - the server response.
 * @param status - HTTP status code.
 * @param body - JSON-serializable body.
 * @param headers - extra or overriding headers.
 */
export function writeJson(res, status, body, headers = {}) {
	const payload = JSON.stringify(body);
	res.writeHead(status, { ...JSON_HEADERS, ...headers });
	res.end(payload);
}

/**
 * Request init that asks a remote origin for an uncompressed body.
 *
 * The DSH host boots `@deepseek-ai/dsh-http-proxy`, whose top-level import of
 * the npm `undici` copy replaces the dispatcher Node's built-in `fetch()` reads;
 * that cross-major wrapper drops the `content-encoding` header and automatic
 * decompression, so a plain fetch resolves to raw gzip/brotli bytes. Every host
 * fetch that parses a remote body must ask for identity encoding.
 * @param init - the caller's request init (signal, headers, method, ...).
 * @returns a copy with `accept-encoding: identity` merged in.
 */
export function withIdentityEncoding(init = {}) {
	const headers = new Headers(init.headers);
	headers.set("accept-encoding", "identity");
	return { ...init, headers };
}