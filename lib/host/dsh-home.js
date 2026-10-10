/**
 * DSH home resolution for the host half.
 *
 * Derived from @linxin666/dsh-usage 0.4.4 (Apache-2.0,
 * https://github.com/zhu1090093659/dsh-web) — `src/dsh-home.ts`. Changed: the
 * exported surface is trimmed to what this plugin persists.
 */

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isAbsolute as posixIsAbsolute, join as posixJoin } from "node:path/posix";

/** Expand a leading ~ (or ~user) in a path, platform-style. */
export function expandHome(path, home = homedir()) {
	const isPosix = home.startsWith("/");
	const j = isPosix ? posixJoin : join;
	if (path === "~") return home;
	if (path.startsWith("~/") || path.startsWith("~\\")) return j(home, path.slice(2));
	return path;
}

/**
 * Resolve the DSH home directory: the DSH_HOME environment override wins, the
 * platform home fallback follows.
 * @param env - process environment to read DSH_HOME from.
 * @param home - platform home directory fallback (test seam).
 * @returns the absolute DSH home path.
 */
export function resolveDshHome(env = process.env, home = homedir()) {
	const isPosix = home.startsWith("/");
	const j = isPosix ? posixJoin : join;
	const isAbs = isPosix ? posixIsAbsolute : isAbsolute;
	const raw = env.DSH_HOME;
	if (raw !== undefined && raw.trim() !== "") {
		const expanded = expandHome(raw.trim(), home);
		return isAbs(expanded) ? expanded : j(process.cwd(), expanded);
	}
	return j(home, ".dsh");
}

/** Resolve the DSH home directory from the live environment. */
export function dshHome() {
	return resolveDshHome();
}