# dsh-account-glance

English | [中文](README.zh.md)

A sidebar glance card for the DSH Web GUI. It sits **directly above** the shell's bottom-left
**account / Settings** row and shows three lines:

| Line | Content |
| --- | --- |
| 1 | DeepSeek **account balance** (primary source: the API-key balance probe; hover for the source) |
| 2 | **Whether the current hour is peak or off-peak**, plus a live **countdown** to the next flip and the **discount** in effect |
| 3 | **Today's spend / tokens / calls**, with a **manual refresh** button in the bottom-right corner |

Peak / off-peak pricing follows DeepSeek's official off-peak schedule (Beijing time, UTC+8 all year,
no daylight saving):

- **Peak** — Monday to Friday `09:00–12:00` and `14:00–18:00`, billed at full price;
- **Off-peak** — every other hour (nights and weekends included), billed at **50% off**.

The countdown switches to seconds for the final minute.

The **manual refresh** button in the bottom-right corner forces one fresh probe cycle on the dsh-usage
host (`POST api/dsh-usage/refresh`) instead of re-reading its cached snapshot, so the number it shows
was just fetched. The button spins and disables while the read is in flight, and stays still under
`prefers-reduced-motion`. It does not change the regular 60-second cadence.

## Turning it on and off

**In the GUI (recommended)**

1. Click the **Plugins** icon in the sidebar (the global panel icon next to **Schedules**);
2. Find the **dsh-account-glance** card in the **Installed** group;
3. Use the card's switch to toggle the whole bundle, or the row switch to toggle the `account-glance` row.

The card disappears from the sidebar immediately when turned off, and dsh-usage's own glance card comes
back automatically. Turning it on reverses both. The change applies instantly — **no restart and no page
refresh needed**.

Under the hood it appends an override to the profile's `cordis.patch.yml`:

```yaml
- id: account-glance
  disabled: true
```

> The plugin list under Settings is **read-only** by design; the switches live on the sidebar's Plugins page.

## Where it sits, and how

The card registers into the shell's own `sidebar.footer.action` list slot (declared by
`@deepseek-ai/dsh-client-ui-sidebar`). That slot renders inside the foot's `.footerActions` container,
which sits directly above `.settingsArea` — the account row. One extra style lets `.footerActions` wrap
so the card claims a full row of its own, keeping the shell's other foot buttons on the row above and
leaving the card on the row directly above the account row.

`@linxin666/dsh-usage` ships its own glance card for that same row. This plugin hides it with CSS
(`[data-dsh-plugin="usage"][data-dsh-part="foot-card"]`) so the two do not stack; dsh-usage's **settings
page and usage ledger are fully preserved**, and this card reads from its `api/dsh-usage/overview`.

The host half is a no-op: this is a pure browser-side surface. It adds no host route and reads no credential.

## Balance source and degradation

The balance's **primary source is dsh-usage's official provider probe** (the `/user/balance` result for
the `deepseek-official` route, resolved in the Host so the credential never reaches the browser). Only
when that probe carries no balance does the card fall back to the existing `account` Remote namespace
(`@deepseek-ai/dsh-api-account-controller`, the same call the Settings → Account & balance page makes) —
so a signed-in-only setup still reads a number.

| Situation | Display |
| --- | --- |
| Probe present (the normal case) | The probed balance, e.g. `¥10.39`, **no star**; hover says "Balance source: DeepSeek API-key balance probe" |
| No probe, `account` endpoint available | The wallet balance; hover names the Settings → Account & balance endpoint |
| No probe and signed out | `未登录` / `Not signed in` |
| Neither source available | `读取失败` / `Unavailable` (the tooltip carries the reason) |
| dsh-usage disabled (404) or failing | Line 3 shows "today's usage unavailable"; with no probe either, the `account` fallback takes over |

The whole card runs on **one 60-second cadence**: the probe value rides along inside the overview, a local
host snapshot, so the headline and the ledger line always describe the same read. Polling pauses while the
tab is hidden. When a probe value exists, the `account` endpoint is **never called** — not one extra round
trip.

### Does probing cost credit?

**No.** The balance probe is `GET https://api.deepseek.com/user/balance` (see dsh-usage's
`core/adapters.ts`) — a read-only account query. It carries no prompt, produces no tokens, and bills
nothing. dsh-usage only ever calls balance / quota query endpoints; there is no inference endpoint anywhere
in its source. The product's own onboarding copy says the same: your balance is only consumed when an Agent
actually runs a task.

The only real cost is the HTTP request itself (and a very small chance of rate limiting), so the cadence
does not need to be tight.

It also helps to keep two cadences apart:

- **This card's 60 seconds** (`USAGE_POLL_MS`) — reads dsh-usage's in-memory snapshot and **never touches
  the network**;
- **The host's probe interval** — owned by dsh-usage's `pollIntervalSec`, default 60 s, minimum 30 s
  (configurable on its 使用统计 / Usage settings page). This is the cadence that actually asks DeepSeek;
- **The manual refresh button** — forces one extra host probe cycle. That is the only place this plugin
  makes an external request happen earlier than scheduled.

The `account` fallback read carries a **15-second hard deadline** (`BALANCE_TIMEOUT_MS`): it is a host
round trip that can end at DeepSeek Platform, and without a deadline one stalled call would pin the
headline to "loading" forever.

## Requirements

- **DSH 0.2.0-rc.1 or newer** (`dsh.engines.dsh`).
- The probe value and today's totals come from **`@linxin666/dsh-usage`**. Without it the plugin still
  works: line 3 shows "today's usage unavailable" and the balance falls back to the `account` endpoint.
- The browser half's only runtime external is **`react`**, provided by DSH's frozen platform module table.
  There is **no build step** — `lib/client.js` is the shipped artifact, so a clone is ready to use.

## Installation

This is a **proper DSH bundle**, the same shape as dsh-usage / dsh-web-all. The profile directory is
usually `~/.dsh/profiles/<profile>`.

```bash
git clone https://github.com/faith372/dsh-account-glance.git
dsh plugin --profile desktop add link:./dsh-account-glance
```

The DSH **Plugins** page also accepts a repository URL in its **Add plugin** dialog.

Installing by hand is the same three steps:

1. Put the source at `<profile>\plugins\dsh-account-glance\`.
2. Declare both the dependency and the bundle in the profile's `package.json`:
   ```json
   "dependencies": { "dsh-account-glance": "link:./plugins/dsh-account-glance" }
   "dsh": { "profile": { "bundles": [ "...", "dsh-account-glance" ] } }
   ```
3. Link it into the profile's `node_modules` (or just run `pnpm install`):
   ```powershell
   New-Item -ItemType Junction `
     -Path   "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-account-glance" `
     -Target "$env:USERPROFILE\.dsh\profiles\desktop\plugins\dsh-account-glance"
   ```

Do **not** also insert `account-glance` into the profile's `cordis.patch.yml` by hand: this package ships
its own `cordis.patch.yml` for that row, and inserting it twice would register the same id twice.

Bundle selection is **hot-applied** (`set_bundle` reports `application: "applied"`); restarting dsh is not
required.

### After changing `lib/client.js`

**Refreshing the browser alone is not enough.** A client bundle's content change only reaches the boot
graph through the HMR hook (`rebuilt()` in `@deepseek-ai/dsh-client-modules`); a same-source rescan skips
re-reading the file. The reliable move is to toggle this row off in the Plugins page, wait a few seconds,
and toggle it back on: removing and re-adding the entry makes the scan re-read the file and mint a new
revision, HMR pushes it at the open page, and one browser refresh picks up the new code.

## Uninstall

- GUI: Plugins page → the dsh-account-glance card → turn it off (both the bundle switch and the row switch);
- Completely: drop `dsh-account-glance` from `dsh.profile.bundles` and `dependencies`, then remove the
  `node_modules\dsh-account-glance` link. The source directory can stay.

dsh-usage's own glance card comes back automatically once this plugin is uninstalled — the CSS that hides
it goes away with the plugin.

## Tunables

All of them live at the top of `lib/client.js`:

| Constant | Default | Meaning |
| --- | --- | --- |
| `USAGE_POLL_MS` | `60000` | The card's whole cadence (local snapshot, no network; matches dsh-usage's probe interval) |
| `BALANCE_TIMEOUT_MS` | `15000` | Hard deadline for the `account` fallback read |
| `USAGE_REFRESH_PATH` | `api/dsh-usage/refresh` | The forced-probe endpoint the manual refresh uses |
| `REFRESH_TIMEOUT_MS` | `25000` | Hard deadline for the manual refresh (a forced probe is slower than a snapshot read) |
| `TICK_MS` | `1000` | Peak / off-peak countdown tick |
| `CLIENT_VERSION` | `0.2.0-rc.2` | The `x-client-version` the `account` fallback carries (Platform client telemetry only) |
| `USAGE_OVERVIEW_PATH` | `api/dsh-usage/overview` | Source of the usage line and the probe value |
| `PEAK_WINDOWS` | weekdays `09:00–12:00`, `14:00–18:00` | Peak windows in Beijing-time minutes |

## Verification

```bash
node test/verify.mjs
```

The script executes the **shipped artifact**, `lib/client.js`, against minimal React / DOM stand-ins, and
covers:

- the bundle registers one factory under its package name, with `react` as its only external;
- `apply()` claims the `sidebar.footer.action` seat (id `account-glance`, order 50), installs the
  stylesheet, starts its loop, and arms **exactly one 60-second cadence**;
- **probe precedence**: a present probe outranks the `account` wallet, carries no star, and the `account`
  endpoint is never called;
- **the fallback path**: with no probe the `account` Remote is read once with a complete client identity,
  and its wallet becomes the headline;
- the peak / off-peak clock's badge and countdown across six boundary shapes (inside the morning window,
  the lunch gap, overnight, the last half minute of a peak window, a weekend, and pre-open Monday);
- a stalled `account` fallback showing its loading state and being settled by the 15-second deadline
  (with captured timers, so nothing actually waits);
- the manual refresh button: position, accessible label, exactly one forced probe per click, the `account`
  re-read when there is no probe, and English copy following the active locale;
- degradation paths: signed out, missing service, throwing read, usage 404/500, an empty day, a decimal
  string `cost`, and an English UI.

## Known limitations

- Hiding dsh-usage's glance card relies on its own `data-dsh-plugin="usage"` / `data-dsh-part="foot-card"`
  attributes. If it renames them, both cards appear (nothing breaks).
- The primary source is the API key's balance probe, so the number belongs to **the DeepSeek account that
  key belongs to**; swapping the key changes the number.
- On this deployment the `account` fallback (browser sign-in) never returns a value, so the probe path is
  what actually runs. The fallback is kept for environments without a probe.
- `CLIENT_VERSION` is a hard-coded constant; if DSH ever starts validating the version, it needs updating.
- The card hides itself while the sidebar is collapsed to its 56 px rail, matching the shell's own foot area.

## License

[MIT](LICENSE)