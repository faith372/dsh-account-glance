# Third-party notices

`dsh-account-glance` is distributed under the MIT license — see [`LICENSE`](LICENSE) —
with one exception: the host-side modules listed below are **derived from
`@linxin666/dsh-usage` v0.4.4**, which is licensed under the **Apache License 2.0**.
Those files stay under Apache-2.0; the full license text is reproduced in
[`LICENSE-APACHE`](LICENSE-APACHE).

- Upstream package: `@linxin666/dsh-usage` v0.4.4
- Upstream repository: <https://github.com/zhu1090093659/dsh-web>
- Upstream license: Apache License 2.0. The upstream package ships the
  unmodified Apache text with no filled-in copyright-holder line and no `NOTICE`
  file, so this notice names the package instead of a holder.
- These files are **modified** copies: each one carries a header naming its
  upstream source and summarizing the changes (Apache-2.0 §4(b)).

| File here | Upstream source | What changed |
| --- | --- | --- |
| `lib/host/dsh-home.js` | `src/dsh-home.ts` | trimmed to the persistence-path resolution |
| `lib/host/http.js` | `shared/host/http.ts` (shipped as `src/host/http.ts`) | only `writeJson` and `withIdentityEncoding` kept |
| `lib/host/access.js` | `shared/host/loopback.ts`, `shared/host/pair-access.ts`, `src/host/access.ts` | merged into one module |
| `lib/host/pricing.js` | `src/core/pricing.ts` | added Beijing date keys; the whole adapter registry replaced by `isDeepSeekRoute` |
| `lib/host/ledger.js` | `src/core/ledger.ts` | Beijing day buckets and a matching prune cutoff |
| `lib/host/probe.js` | DeepSeek entry of `src/core/adapters.ts`; `resolveCredential` / `listProviderRoutes` / `probeRoute` of `src/host/usage-service.ts` | DeepSeek family only; credential helpers inlined as plain strings so no `@deepseek-ai/*` runtime import is needed |
| `lib/host/service.js` | `src/host/usage-service.ts` | DeepSeek family only; no plan/quota probing, voucher, observed-spend watch or settings form; fixed cadence and retention; overview trimmed to what the card renders |
| `lib/host/routes.js` | `src/host/routes.ts` | this plugin's own route prefix |
| `lib/index.js` | `src/index.ts` | no `mountOnce` wrapper and no settings schema; the service is created directly |

Not derived, so plain MIT: `lib/client.js`, `test/verify.mjs`,
`test/host-verify.mjs`, the documentation, and the bundle patch. The browser
half does consume the same overview payload shape (`providers[].balance`,
`usage.today.totals`) that dsh-usage serves, which is why the two can back the
same card.