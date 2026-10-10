# dsh-account-glance

[English](README.md) | 中文

DSH Web GUI 侧栏底部速览卡：坐在侧栏最底部「个人账户 / 设置」那一行的**正上方**，三行显示

| 行 | 内容 |
| --- | --- |
| 1 | DeepSeek **账户余额**（主来源：API Key 余额探测；悬停显示来源） |
| 2 | **当前是峰还是谷** + 距下次切换的**倒计时** + 当前**折扣** |
| 3 | **今日消费 / tokens / 调用次数**，右下角一个**手动刷新**按钮 |

峰谷口径（DeepSeek 官方 API 错峰计价，北京时间，全年 UTC+8 无夏令时）：

- **高峰**：周一至周五 09:00-12:00、14:00-18:00，原价；
- **谷时**：其余全部时段（含夜间与周末），按高峰价的 **5 折**。

倒计时在最后 1 分钟改为按秒显示。

右下角的**手动刷新**按钮会对**本插件自己的宿主半区**强制跑一轮新探测（`POST api/dsh-account-glance/refresh`），而不是重读它已有的快照，所以数字是刚取到的。读取期间按钮旋转并禁用，`prefers-reduced-motion` 下不旋转；它不改变常规的 60 秒节奏。

## 打开与关闭

**在界面里（推荐）**

1. 点侧栏的**「插件」**图标（全局面板里 **定时任务** 旁边那个）；
2. 在**已安装**分组里找到 **dsh-account-glance** 卡片；
3. 卡片开关管整个组合包，行开关管 `account-glance` 这一行。

关掉后卡片立刻从侧栏消失，dsh-usage 自己的速览卡自动回来；打开则反向。即时生效，**不用重启，也不用刷新页面**。

底层就是往 profile 的 `cordis.patch.yml` 追加一条覆盖：

```yaml
- id: account-glance
  disabled: true
```

> 设置里的「插件列表」是**只读**的；开关只在侧栏「插件」页。

## 位置与实现

卡片注册进外壳自己的 `sidebar.footer.action` list slot（由 `@deepseek-ai/dsh-client-ui-sidebar` 声明），该 slot 渲染在 `.footArea` 的 `.footerActions` 容器内，而该容器就紧挨在 `.settingsArea`（个人账户行）上方。插件另加一条样式让 `.footerActions` 允许换行、卡片占满整行，于是侧栏折叠轨里的其它底部按钮保留在上一行，卡片独占「账户行正上方」这一行。

同一块区域原本还有 `@linxin666/dsh-usage` 的「侧栏底部速览卡」。本插件用 CSS 隐藏了它（`[data-dsh-plugin="usage"][data-dsh-part="foot-card"]`），避免两行重复；dsh-usage 的**设置页与用量统计完全保留**。本卡默认读自己的宿主路由，不再依赖它。

宿主半区拥有两个数据源：它把 session 事件折叠成用量账本、用宿主持有的凭据探测 DeepSeek 余额（凭据永不进入浏览器），并通过两条仅回环可访问的路由（`api/dsh-account-glance/overview`、`.../refresh`）把这些数据给到浏览器。改编自 `@linxin666/dsh-usage` 的部分见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。

## 余额来源与降级

余额**主来源是本插件自己的宿主探测**：宿主半区从 DSH 凭据存储里解析 DeepSeek API Key，调用 `GET https://api.deepseek.com/user/balance`，再把结果通过 `api/dsh-account-glance/overview` 给到浏览器——Key 只留在宿主进程里，永不进入浏览器。只有在探测值缺失时，才回退到宿主已有的 `account` Remote 命名空间（`@deepseek-ai/dsh-api-account-controller`，即「设置 → 账号与余额」那个接口）——所以只有登录态的环境仍然能读到数字。

| 情况 | 显示 |
| --- | --- |
| 探测值存在（常态） | 探测余额，例如 `¥10.39`，**无星号**；悬停提示「余额来源：DeepSeek API Key 余额探测」 |
| 探测值缺失，`account` 接口可用 | 钱包余额；悬停提示「余额来源：设置 → 账号与余额接口」 |
| 探测值缺失且未登录 | `未登录` |
| 两个来源都不可用 | `读取失败`（悬停提示带原因） |
| 宿主半区完全没加载（404） | 第 3 行显示「今日用量不可用」（悬停会说明原因）；余额自动走 `account` 回退 |

整张卡只有**一个 60 秒节奏**：探测值本来就搭在 overview 这条本地宿主快照里，所以头条与用量行始终描述同一轮读取；标签页不可见时暂停。探测值存在时**根本不会调用** `account` 接口，一次多余往返都不花。

### 今日用量账本

第 3 行同样由宿主半区算出来：它订阅 session 事件流（`session/event`），把每条带 `usage` 的 `assistant/message` 折叠进一份按天的账本，**按北京日期分桶**，所以某一天和它对应的计价时段永远不会打架。只有 DeepSeek 官方路由会计价（CNY / 百万 token，峰谷价表在 `lib/host/pricing.js`）；其它路由照样统计 tokens 与调用次数，但 cost 记为 0，因此混合账本不会把两种货币加在一起。账本落在 `<DSH_HOME>/account-glance/ledger.json`（原子写、3 秒去抖、保留 180 天）。

### 探测要花额度吗

**不花。** 余额探测是 `GET https://api.deepseek.com/user/balance`（见 `lib/host/probe.js`），一个只读的账户余额查询：不带 prompt、不产生 token、不扣额度。本插件只调用这一个余额端点，源码里没有任何推理端点。产品自己的引导文案也写着「你的余额只会在 Agent 实际执行任务时消耗」。

唯一真实代价是 HTTP 请求本身（以及极小概率的限流），所以频率不需要太高。

还要区分三个节奏：

- **本卡片的 60 秒**（`USAGE_POLL_MS`）：只读宿主内存里的快照，**完全不碰外网**；
- **宿主的探测周期**：本插件自己的轮询，默认 60 秒（`lib/host/service.js` 顶部的 `DEFAULT_POLL_SEC`，下限 30 秒），这才是真正去问 DeepSeek 的那个节奏；
- **手动刷新按钮**：额外强制跑一轮宿主探测（那是本插件唯一会让外网请求提前发生的地方）。

`account` 回退读取带 **15 秒硬超时**（`BALANCE_TIMEOUT_MS`）：那是一个可能落到 DeepSeek Platform 的宿主往返，没有超时的话一次卡住的调用会把头条永远钉在「读取中…」。

## 依赖

- 需要 **DSH 0.2.0-rc.1 或更高**（`dsh.engines.dsh`）。
- **不依赖任何其它插件。** 余额探测与用量账本都在本插件自己的宿主半区里。`@linxin666/dsh-usage` 变成可选：装了也不会冲突——本卡仍然优先读自己的宿主路由，dsh-usage 的速览卡继续被隐藏，它的设置页与用量统计照常可用。
- 客户端半区唯一的运行时外部依赖是 **`react`**（由 DSH 平台的冻结模块表提供）；宿主半区只用 Node 标准库，**没有构建步骤**——`lib/client.js` 就是交付产物，clone 下来即可用。

## 安装

本插件是**正规组合包**，形态与 dsh-usage / dsh-web-all 一致。profile 目录通常是 `~/.dsh/profiles/<profile>`。

```bash
git clone https://github.com/faith372/dsh-account-glance.git
dsh plugin --profile desktop add link:./dsh-account-glance
```

DSH 的「插件」页也支持在**添加插件**对话框里直接填仓库地址。

手动安装等价于三步：

1. 源码放到 `<profile>\plugins\dsh-account-glance\`。
2. profile 的 `package.json` 同时声明依赖与组合包：

   ```json
   "dependencies": { "dsh-account-glance": "link:./plugins/dsh-account-glance" }
   "dsh": { "profile": { "bundles": [ "...", "dsh-account-glance" ] } }
   ```

3. 链接进 profile 的 `node_modules`（或跑一次 `pnpm install`）：

   ```powershell
   New-Item -ItemType Junction `
     -Path   "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-account-glance" `
     -Target "$env:USERPROFILE\.dsh\profiles\desktop\plugins\dsh-account-glance"
   ```

**不要**再往 profile 的 `cordis.patch.yml` 手工 insert 一次 `account-glance`：那一行由本包自己的 `cordis.patch.yml` 提供，再插一遍会让同一个 id 被插入两次。

组合包选择是**热生效**的（`set_bundle` 返回 `application: "applied"`），改设置也不需要重启。

### 从 1.3.x 升级

1.4.0 新增了宿主半区，所以插件行必须重新挂载一次它才会生效：重启 DSH，或者在「插件」页把这一行关掉再打开，然后刷新页面拿到新的客户端 bundle。在它生效之前，如果装了 `@linxin666/dsh-usage`，卡片会回退读它的 overview；没装则第 3 行显示「今日用量不可用」（悬停会说明原因）。

### 改动 lib/client.js 之后

**只刷新浏览器是不够的。** 客户端 bundle 的内容变化只有通过 HMR 钩子（`@deepseek-ai/dsh-client-modules` 里的 `rebuilt()`）才会进入 boot graph；同源码重扫会跳过重新读取文件。可靠做法是在「插件」页把这一行关掉、等几秒再打开：移除再添加条目会让扫描重新读文件并生成新 revision，HMR 推给已打开的页面，再刷新一次浏览器就拿到新代码。

## 卸载

- 界面：插件页 → dsh-account-glance 卡片 → 关掉（组合包开关和行开关都关）；
- 彻底卸载：从 `dsh.profile.bundles` 和 `dependencies` 里删掉 `dsh-account-glance`，再删掉 `node_modules\dsh-account-glance` 链接。源码目录可以留着。

卸载后 dsh-usage 自己的速览卡会自动回来——隐藏它的那条 CSS 随插件一起消失。

## 调参

都在 `lib/client.js` 顶部：

| 常量 | 默认 | 含义 |
| --- | --- | --- |
| `USAGE_POLL_MS` | `60000` | 整张卡的轮询周期（本地快照，不碰外网；与宿主探测周期一致） |
| `BALANCE_TIMEOUT_MS` | `15000` | `account` 回退读取的硬超时 |
| `USAGE_REFRESH_PATH` | `api/dsh-account-glance/refresh` | 手动刷新时走的强制探测端点 |
| `REFRESH_TIMEOUT_MS` | `25000` | 手动刷新的硬超时（强制探测比读快照慢） |
| `TICK_MS` | `1000` | 峰谷倒计时刷新 |
| `CLIENT_VERSION` | `0.2.0-rc.2` | `account` 回退调用携带的 `x-client-version`（仅用于 Platform 客户端遥测） |
| `USAGE_OVERVIEW_PATH` | `api/dsh-account-glance/overview` | 用量与探测值来源 |
| `PEAK_WINDOWS` | 工作日 `09:00-12:00`、`14:00-18:00` | 高峰窗口（北京时间分钟数） |

宿主半区另有自己的常量：`lib/host/service.js` 顶部的 `DEFAULT_POLL_SEC`（60）与 `DEFAULT_RETAIN_DAYS`（180），以及 `lib/host/probe.js` 里的 `PROBE_TIMEOUT_MS`（10000）。它们刻意做成常量——本插件不带设置页，因此没有任何需要重算或重挂载的保存动作。

## 验证

```bash
npm test          # 等价于 node test/verify.mjs && node test/host-verify.mjs
```

浏览器侧脚本直接执行 `lib/client.js` 这份**产物**，用最小的 React / DOM 替身把插件跑起来，覆盖：

- bundle 以包名注册 factory，且唯一外部依赖是 `react`；
- `apply()` 认领 `sidebar.footer.action` 座位（id `account-glance`、order 50）、装样式、起轮询，并**只布一个 60 秒节奏**；
- **探测值优先**：探测值在时压过 `account` 钱包、无星号、且 `account` 接口一次都不被调用；
- **回退路径**：没有探测值时才调 `account`，其调用身份字段完整、钱包金额进入头条；
- 峰谷时钟在 6 个边界场景（早高峰内 / 午休 / 夜间 / 高峰最后半分钟 / 周末 / 周一开盘前）的徽标与倒计时；
- `account` 回退卡住时显示「读取中…」，并在 15 秒后由超时收口（含定时器抓取）；
- 手动刷新按钮：位置/无障碍标签、点一次只发一次强制探测、无探测值时同一击也重读 `account`、英文文案跟随语言；
- 未登录、服务缺失、读取抛错、用量 404/500、今日零用量、`cost` 为字符串、英文界面等降级路径；
- 自己的宿主路由 404 时回退读 `@linxin666/dsh-usage` 的 overview，三行不丢。

`test/host-verify.mjs` 用同样方式（不联网、不启动 DSH）覆盖宿主半区：

- 峰谷时钟的窗口边界、周末与周一开盘前，以及账本使用的北京日期键；
- 价表（flash 行与已折算的 pro 行）与折叠时刻的成本盖章；
- 账本：折叠、汇总、按保留期裁剪、不可信 JSON 的还原、原型键防护；
- 凭证解析顺序（pi-ai 记录 → 配置的 env 引用 → 无，以及无 credentials 服务时的环境变量兜底）与探测本身（端点、Bearer 头、`accept-encoding: identity`、401 / 空体 / 畸形体）；
- 异源防护：`baseURL` 指向转售商的 route 会被标为不支持，而不会用官方端点去探；
- session 事件折叠成今日用量（按计价时段定价；非 DeepSeek 路由只计数、不产生 cost；未归因或畸形事件直接丢弃）；
- 路由信任栅栏（回环与配对设备 200、局域网 403、跨站 403、GET 打 refresh 405）与并发探测合并；
- 重启后的持久化，以及宿主入口注册 / 注销两条路由。

## 已知限制

- 隐藏 dsh-usage 速览卡依赖它自己的 `data-dsh-plugin="usage"` / `data-dsh-part="foot-card"` 属性；它若改名，两张卡会同时出现（功能不受影响）。
- 主来源是 API Key 的余额探测，因此显示的是**该 Key 所属 DeepSeek 账户**的余额；换 Key 就会换数字。profile 里没有 DeepSeek 凭据时没有探测值，走 `account` 回退。
- `baseURL` 指向 `api.deepseek.com` 之外的 route **不会**用官方端点探测；它会显示为「不支持余额」，而不是把另一个账户的钱显示出来。
- 只对 DeepSeek 官方路由计价（公开的 CNY 峰谷价表）。如果 profile 是通过别的 provider（例如 DashScope 兼容路由）访问 DeepSeek 模型，则只显示 tokens 与调用次数，没有消费金额。
- 同时装了 `@linxin666/dsh-usage` 时，两份账本各自统计，数字可能略有差异：本卡按北京日期分桶，dsh-usage 按宿主本地日期分桶。
- 本部署上 `account` 回退（浏览器登录态）一直读不到值，所以实际生效的是探测值路径；回退代码保留是为了没有探测值的环境。
- `CLIENT_VERSION` 是写死的常量，DSH 升级后若 Platform 开始校验版本号，需要同步更新。
- 侧栏折叠为 56px 轨时卡片隐藏（与外壳自己的底部区域一致）。

## 许可证

[MIT](LICENSE)