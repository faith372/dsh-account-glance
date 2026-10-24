# dsh-account-glance

English | [中文](README.zh.md)

<p align="center">
  <img src="assets/card.png" alt="The three-line glance card: account balance, peak / off-peak countdown, and today's tokens and calls" width="264">
  <br>
  <sub>The live card: probed balance, Beijing peak / off-peak clock, and today's ledger.</sub>
</p>

A three-line glance card for the DSH Web GUI, seated **directly above** the sidebar's bottom-left
**account / Settings** row:

| Line | Content |
| --- | --- |
| 1 | DeepSeek **account balance** — probed from `/user/balance` with the host-held API key; hover names the source |
| 2 | **Peak / off-peak** billing period, with a live countdown to the next flip and the discount in effect |
| 3 | **Today's spend / tokens / calls**, plus a **manual refresh** button that forces one fresh probe |

Peak / off-peak follows DeepSeek's official schedule (Beijing time, UTC+8 all year): **peak** is
Monday–Friday `09:00–12:00` and `14:00–18:00` at full price, **every other hour** (nights and weekends)
plus **every Chinese statutory public holiday in full** is billed at **50% off**. The countdown switches
to seconds for the final minute.

## Install

Needs **DSH 0.2.0-rc.1 or newer**. No other plugin, no dependencies, no build step.

```bash
git clone https://github.com/faith372/dsh-account-glance.git
dsh plugin --profile desktop add link:./dsh-account-glance
```

The Plugins page also accepts the repository URL in its **Add plugin** dialog. Installing by hand: put
the source at `<profile>\plugins\dsh-account-glance\`, add the package to both `dependencies` and
`dsh.profile.bundles`, then link it into `node_modules` (or run `pnpm install`). Do **not** add
`account-glance` to `cordis.patch.yml` yourself — the package ships that row.

**Upgrading from 1.4.x:** the clock and price book changed (statutory holidays, v4-pro pricing), so
restart DSH (or toggle this row off and on in the Plugins page) and refresh the page once. From 1.3.x it
is the same step — 1.4.0 introduced the host half.

## Turning it on and off

Sidebar **Plugins** icon → **Installed** → **dsh-account-glance**: the card switch toggles the whole
bundle, the row switch toggles this card. Instant — no restart, no refresh — and turning it off brings
dsh-usage's own glance card back.

## Where the numbers come from

Both data sources live in this plugin's own host half and are served over loopback-only routes
(`api/dsh-account-glance/overview`, `.../refresh`); the API key never reaches the browser.

- **Balance** — `GET https://api.deepseek.com/user/balance`, with the key resolved from the DSH
  credential store (pi-ai record → configured env reference → ambient env). No probe value falls back to
  the `account` Remote (Settings → Account & balance). A route pointed at a reseller is reported as
  unsupported rather than probed with the official endpoint; a failure keeps the last good number and
  flags the row.
- **Today's usage** — folded from the session event stream into a small per-day ledger at
  `<DSH_HOME>/account-glance/ledger.json` (atomic write, 180-day retention), keyed by **Beijing date**.
- **Cost** is priced for DeepSeek official routes only, from the published CNY peak / off-peak table
  (flash and v4-pro each on their own row). Other routes — a DashScope-compatible provider, for
  example — still count tokens and calls, at cost 0, so a mixed ledger never sums two currencies.
- **Holidays** — the official schedule bills Chinese public holidays as whole off-peak days. The table
  ships 2026 from the official notice and 2027 derived; a later year needs no release, only a file in the
  data directory:

  ```json
  { "holidays": ["2027-01-01", "2027-02-05"] }
  ```

  Written to `<DSH_HOME>/account-glance/holidays.json` it is merged into the built-in table at startup
  (`{ "replace": true, "holidays": [...] }` swaps the built-in table out instead). The host applies it
  and serves the effective calendar to the card, so the badge and the ledger's cost column always agree.
- `@linxin666/dsh-usage` is **optional**: install it and nothing breaks — this card still reads its own
  route first, its glance card stays hidden, and its settings and usage pages keep working.

Probing is a read-only account query: no prompt, no tokens, no credit.

## Verify

```bash
npm test    # node test/verify.mjs && node test/host-verify.mjs
```

Both suites run offline. The client suite boots the shipped `lib/client.js` against React / DOM
stand-ins: seat and cadence, the probe outranking the account wallet, the fallback identity, the peak
clock's boundary cases, the 15-second deadline, the refresh button, the degradation paths, and the
dsh-usage fallback. The host suite covers the clock and price book, the ledger, credential resolution
and probe shapes, the origin guard, session folding, the route fence, persistence across a restart, and
the entry point.

## Known limitations

- Hiding dsh-usage's glance card relies on its `data-dsh-plugin="usage"` / `data-dsh-part="foot-card"`
  attributes; if it renames them, both cards appear (nothing breaks).
- The balance belongs to the DeepSeek account the configured key belongs to — swap the key, swap the number.
- Cost appears for DeepSeek official routes only; other routes show tokens and calls without an amount.
- With dsh-usage installed too, both plugins keep their own ledger (this one buckets days by Beijing date,
  dsh-usage by host-local date), so the two totals can differ slightly.
- The built-in holiday table quotes 2026 (国办发明电〔2025〕7号) and **derives** 2027 — the statutory dates
  come from the lunar calendar, the bridge days follow the 2025/2026 pattern — so 2027 can shift when the
  official notice lands. Correct it in the package, or per profile through `holidays.json` (see above).
- The card hides while the sidebar is collapsed to its 56 px rail, matching the shell's own foot area.

## License

MIT — except `lib/host/*` and `lib/index.js`, adapted from
[`@linxin666/dsh-usage`](https://github.com/zhu1090093659/dsh-web) v0.4.4 (Apache-2.0). See
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) and [`LICENSE-APACHE`](LICENSE-APACHE).