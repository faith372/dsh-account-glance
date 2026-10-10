# dsh-account-glance

[English](README.md) | 中文

<p align="center">
  <img src="assets/card.png" alt="三行速览卡：账户余额、峰谷倒计时、今日 tokens 与调用次数" width="264">
  <br>
  <sub>实际卡片：探测余额、北京时间的峰谷时钟、今日账本。</sub>
</p>

DSH Web GUI 的侧栏速览卡，坐在侧栏最底部「个人账户 / 设置」那一行的**正上方**，三行显示：

| 行 | 内容 |
| --- | --- |
| 1 | DeepSeek **账户余额**（用宿主持有的 API Key 探测 `/user/balance`；悬停显示来源） |
| 2 | **峰 / 谷**计价时段 + 距下次切换的**倒计时** + 当前折扣 |
| 3 | **今日消费 / tokens / 调用次数**，右下角**手动刷新**按钮可强制跑一轮新探测 |

峰谷口径（DeepSeek 官方错峰计价，北京时间，全年 UTC+8）：**高峰** 为周一至周五 `09:00-12:00`、`14:00-18:00`，原价；**其余全部时段**（含夜间与周末）按 **5 折** 计。倒计时在最后 1 分钟改为按秒显示。

## 安装

需要 **DSH 0.2.0-rc.1 或更高**。不依赖其它插件，无额外依赖，也没有构建步骤。

```bash
git clone https://github.com/faith372/dsh-account-glance.git
dsh plugin --profile desktop add link:./dsh-account-glance
```

「插件」页的**添加插件**对话框也支持直接填仓库地址。手动安装：源码放到 `<profile>\plugins\dsh-account-glance\`，把包同时加进 profile 的 `dependencies` 与 `dsh.profile.bundles`，再链接进 `node_modules`（或跑一次 `pnpm install`）。**不要**自己往 `cordis.patch.yml` 里再插一次 `account-glance`——那一行由本包自带。

**从 1.3.x 升级**：1.4.0 新增了宿主半区，重启一次 DSH（或在「插件」页把这一行关掉再打开）并刷新一次页面即可。

## 打开与关闭

侧栏**「插件」**图标 → **已安装** → **dsh-account-glance**：卡片开关管整个组合包，行开关管本卡。即时生效，不必重启或刷新；关掉后 dsh-usage 自己的速览卡自动回来。

## 数据从哪来

两个数据源都在本插件自己的宿主半区里，通过仅回环可访问的路由（`api/dsh-account-glance/overview`、`.../refresh`）提供给页面，API Key 永不进入浏览器。

- **余额**：`GET https://api.deepseek.com/user/balance`，Key 按「pi-ai 记录 → 配置的 env 引用 → 环境变量」顺序解析。没有探测值时回退到 `account` Remote（设置 → 账号与余额）。`baseURL` 指向转售商的 route 会显示为「不支持余额」，而不是拿官方端点去探；探测失败会保留上一个好数字并标出错误。
- **今日用量**：折叠 session 事件流，落在 `<DSH_HOME>/account-glance/ledger.json`（原子写、保留 180 天），**按北京日期分桶**。
- **消费金额**只对 DeepSeek 官方路由计价（公开的 CNY 峰谷价表）；其它路由（例如 DashScope 兼容 provider）照常统计 tokens 与次数，金额为 0，因此混合账本不会把两种货币加在一起。
- `@linxin666/dsh-usage` 是**可选**的：装了也不会冲突——本卡仍然优先读自己的路由，它的速览卡继续被隐藏，设置页与用量统计照常可用。

探测本身是只读的账户查询：不带 prompt、不产生 token、不扣额度。

## 验证

```bash
npm test    # 等价于 node test/verify.mjs && node test/host-verify.mjs
```

两套都离线运行。客户端套件执行交付产物 `lib/client.js`（座位与节奏、探测值压过 `account` 钱包、回退调用的身份字段、峰谷边界、15 秒超时、刷新按钮、各降级路径、回退读 dsh-usage）；宿主套件覆盖时钟与价表、账本、凭证解析与探测形态、异源防护、session 折叠、路由栅栏、重启后的持久化与入口注册。

## 已知限制

- 隐藏 dsh-usage 速览卡依赖它自己的 `data-dsh-plugin="usage"` / `data-dsh-part="foot-card"` 属性；它改名则两张卡会同时出现（功能不受影响）。
- 余额属于当前 Key 所属的 DeepSeek 账户，换 Key 就会换数字。
- 只有 DeepSeek 官方路由会出金额，其它路由只有 tokens 与调用次数。
- 同时装了 dsh-usage 时两份账本各自统计（本卡按北京日期分桶，它按宿主本地日期分桶），数字可能略有差异。
- 侧栏折叠为 56px 轨时卡片隐藏（与外壳自己的底部区域一致）。

## 许可证

MIT；例外是 `lib/host/*` 与 `lib/index.js`，改编自 [`@linxin666/dsh-usage`](https://github.com/zhu1090093659/dsh-web) v0.4.4（Apache-2.0）。见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) 与 [`LICENSE-APACHE`](LICENSE-APACHE)。