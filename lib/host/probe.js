/**
 * The DeepSeek official balance probe: which routes to ask, which credential to
 * ask with, and how to read the answer.
 *
 * Derived from @linxin666/dsh-usage 0.4.4 (Apache-2.0,
 * https://github.com/zhu1090093659/dsh-web) — the DeepSeek entry of
 * `src/core/adapters.ts` and `UsageService.resolveCredential` /
 * `listProviderRoutes` / `probeRoute` in `src/host/usage-service.ts`. Changed:
 * only the DeepSeek family is supported, the foreign-settings lookup is reduced
 * to the two settings-service reads that matter, and the credential helpers are
 * inlined as plain strings (they are compile-time brands upstream, so no
 * `@deepseek-ai/*` import is needed).
 */

import { DEEPSEEK_API_ORIGIN, isDeepSeekRoute } from "./pricing.js";
import { withIdentityEncoding } from "./http.js";

/** Hard deadline for one balance probe. */
export const PROBE_TIMEOUT_MS = 10_000;

/** The route ids probed when the llm registry enumerates nothing. */
const FALLBACK_ROUTE_IDS = ["deepseek-official"];

/** The env reference the official DeepSeek adapter falls back to. */
const DEFAULT_API_KEY_ENV = "DEEPSEEK_API_KEY";

/** Best-effort typed service read: absent services resolve to undefined. */
export function service(ctx, name) {
	try {
		return typeof ctx?.get === "function" ? ctx.get(name) : undefined;
	} catch {
		return undefined;
	}
}

/** Follow a volatile config reference to its committed value. */
function unwrapVolatiles(value) {
	if (value === null || value === undefined) return value;
	if (typeof value === "object") {
		if (typeof value.get === "function") return unwrapVolatiles(value.get());
		if (Array.isArray(value)) return value.map(unwrapVolatiles);
		const result = {};
		for (const [key, entry] of Object.entries(value)) result[key] = unwrapVolatiles(entry);
		return result;
	}
	return value;
}

/**
 * Read a foreign settings namespace's resolved value (the llm adapter
 * profiles). Tries the legacy `settings.get(ns)` form and the 0.1.7
 * `settings.describe()` form; an unregistered namespace reads as undefined and
 * nothing here throws into the poll loop.
 * @param ctx - host context.
 * @param ns - the namespace id, e.g. `llm-deepseek`.
 * @returns the resolved value or undefined.
 */
export function readNamespace(ctx, ns) {
	const settings = service(ctx, "settings");
	if (settings === undefined) return undefined;
	try {
		if (typeof settings.get === "function") {
			const value = settings.get(ns);
			if (value !== undefined) return unwrapVolatiles(value);
		}
	} catch {
		// Falls through to the descriptor form.
	}
	try {
		if (typeof settings.describe === "function") {
			const descriptors = settings.describe({ redactSecrets: false });
			if (Array.isArray(descriptors)) {
				const match = descriptors.find((entry) => entry !== null && typeof entry === "object" && entry.ns === ns);
				if (match !== undefined) return unwrapVolatiles(match.value);
			}
		}
	} catch {
		// Unregistered or unreadable namespaces read as undefined.
	}
	return undefined;
}

/**
 * Every DeepSeek route worth probing: the runtime's live routes when the llm
 * registry enumerates any, else the configurable catalog's entries, else the
 * official route. The alias fold of upstream (`foldAliasRoutes`) is implied by
 * preferring live routes over catalog ones.
 * @param ctx - host context.
 * @returns route ids.
 */
export function listDeepSeekRoutes(ctx) {
	const live = new Set();
	const catalog = new Set();
	const llm = service(ctx, "llm");
	if (llm !== undefined) {
		try {
			for (const provider of llm.listProviders?.() ?? []) {
				if (isDeepSeekRoute(provider?.id)) live.add(provider.id);
			}
		} catch {
			// A registry hiccup degrades to the catalog or the fallback list.
		}
		try {
			for (const provider of llm.listConfigurableProviders?.() ?? []) {
				if (isDeepSeekRoute(provider?.provider)) catalog.add(provider.provider);
			}
		} catch {
			// Same degradation.
		}
	}
	const ids = live.size > 0 ? [...live] : [...catalog];
	return ids.length > 0 ? ids : [...FALLBACK_ROUTE_IDS];
}

/** The env reference name configured for one route, when it can be read. */
function apiKeyEnvFor(ctx, provider) {
	const piAi = readNamespace(ctx, "llm-pi-ai");
	const fromPiAi = piAi?.providers?.[provider]?.apiKeyEnv;
	if (typeof fromPiAi === "string" && fromPiAi !== "") return fromPiAi;
	if (!isDeepSeekRoute(provider)) return undefined;
	const deepseek = readNamespace(ctx, "llm-deepseek");
	const fromDeepseek = deepseek?.apiKeyEnv;
	return typeof fromDeepseek === "string" && fromDeepseek !== "" ? fromDeepseek : DEFAULT_API_KEY_ENV;
}

/**
 * The configured base URL for one route, when the profile overrides the
 * official origin.
 * @param ctx - host context.
 * @param provider - route id.
 * @returns the base URL or undefined.
 */
export function routeBaseUrl(ctx, provider) {
	const piAi = readNamespace(ctx, "llm-pi-ai");
	const fromPiAi = piAi?.providers?.[provider]?.baseURL;
	if (typeof fromPiAi === "string" && fromPiAi !== "") return fromPiAi;
	if (!isDeepSeekRoute(provider)) return undefined;
	const deepseek = readNamespace(ctx, "llm-deepseek");
	const fromDeepseek = deepseek?.baseURL;
	return typeof fromDeepseek === "string" && fromDeepseek !== "" ? fromDeepseek : undefined;
}

/**
 * Whether the official balance endpoint may be asked for this route. The
 * endpoint reports one account (the official origin), so a profile that points
 * a shared route id at another host is a different account and must not be
 * probed with it — it reports the balance as unsupported instead.
 * @param baseURL - the route's configured base URL, when any.
 * @returns true when the official probe applies.
 */
export function balanceAppliesToRoute(baseURL) {
	if (baseURL === undefined) return true;
	let origin;
	try {
		origin = new URL(baseURL).origin;
	} catch {
		return true;
	}
	return origin === DEEPSEEK_API_ORIGIN;
}

/**
 * Resolve the credential backing one route: the pi-ai credential record first,
 * then the configured env reference. The key stays in the host process.
 * @param ctx - host context.
 * @param provider - route id.
 * @returns `{ kind, key? }` with `kind` one of `api-key` | `env` | `none`.
 */
export async function resolveCredential(ctx, provider) {
	const credentials = service(ctx, "credentials");
	if (credentials === undefined) {
		// A host without the credentials service still gets the ambient env var,
		// so a plainly configured deployment is not left blank.
		const envName = apiKeyEnvFor(ctx, provider);
		const ambient = envName === undefined ? undefined : process.env[envName];
		return typeof ambient === "string" && ambient !== "" ? { kind: "env", key: ambient } : { kind: "none" };
	}
	try {
		// `credentialKey('llm-pi-ai', provider)` is a compile-time brand over
		// exactly this string.
		const record = await credentials.readRecord("llm-pi-ai/" + provider);
		if (record?.kind === "api-key" && typeof record.key === "string" && record.key !== "") {
			return { kind: "api-key", key: record.key };
		}
	} catch {
		// Invalid record ids read as absent.
	}
	try {
		const envName = apiKeyEnvFor(ctx, provider);
		if (typeof envName === "string" && envName !== "") {
			// `credentialRef(envName)` is the same plain string, validated on the
			// host side against the env-var grammar.
			const resolved = await credentials.resolve(envName);
			if (resolved?.value !== undefined && resolved.value !== "") return { kind: "env", key: resolved.value };
		}
	} catch {
		// Malformed references read as absent.
	}
	return { kind: "none" };
}

/** Trim a non-empty string, or undefined. */
function str(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Ask the official DeepSeek balance endpoint for one credential.
 * @param apiKey - the resolved API key.
 * @returns `{ currency, totalBalance, updatedAt }`.
 * @throws when the endpoint answers non-200, the body is unreadable, or the
 *   shape is not a balance document.
 */
export async function probeBalance(apiKey) {
	const response = await fetch(DEEPSEEK_API_ORIGIN + "/user/balance", withIdentityEncoding({
		headers: { authorization: "Bearer " + apiKey },
		signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
	}));
	if (!response.ok) {
		let detail;
		try {
			detail = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 120);
		} catch {
			detail = "";
		}
		throw new Error("HTTP " + response.status + (detail === "" ? "" : ": " + detail));
	}
	const body = await response.json().catch(() => undefined);
	const infos = typeof body === "object" && body !== null ? body.balance_infos : undefined;
	if (!Array.isArray(infos) || infos.length === 0) throw new Error("unrecognized response shape");
	const first = infos[0];
	const currency = str(first?.currency);
	const totalBalance = str(first?.total_balance);
	if (currency === undefined || totalBalance === undefined) throw new Error("unrecognized response shape");
	return { currency, totalBalance, updatedAt: Date.now() };
}

/**
 * Truncate a probe error for the wire.
 * @param message - the raw message.
 * @returns at most 200 characters.
 */
export function truncateError(message) {
	return String(message).slice(0, 200);
}