# iPhone Telemetry Hub

手机上的遥测中心，和 Mac 上那个（MacTelemetryHub）是同一件事的手机版：
**一个入口、一个信封、一个模块字典**，只带这次真的变了的模块，POST 到
`/api/ingest/iphone`。站点那侧怎么收、卡片怎么画，见仓库根目录 README。

眼下只有一个模块：**活动圆环** —— 手表全天戴着，三环（活动 / 锻炼 / 站立）加当天
步数、距离、爬楼层数。

## 和 Mac 那个哪里不一样

**骨架照抄，字段不照抄。** Mac 的信封里有 `heartbeatAt` / `presence` /
`activeModules`，这里一个都没有：它们在那边成立是因为 Mac 上跑的是常驻进程 ——
心跳能证明它还活着，`activeModules` 能让充电头在没有新读数时继续续命。

这个 App **平时根本不在运行**。它是模块自己的唤醒源（活动圆环那条是 HealthKit 的
观测）把它从后台拉起来的，报完就又睡了。照搬那三个字段只会让站点以为自己能判断
手机在不在线 —— 判不了。所以这条链路上没有存活、没有心跳，站点那张卡的新鲜度只看
「最近更新过没有」。协议版本号也从 1 起，不接着 Mac 的 4：两套协议各活各的。

## 加一个模块

写一个 `TelemetryModule` 的实现放进 `App/iPhoneTelemetryHub/Modules/`，然后在
`Modules.all` 里加一行。**hub 不用改** —— 它不认识任何具体模块，只会让它们各自注册
唤醒源、各自交出快照。

协议为什么存在（而不是像 Mac 那样写一个「每个模块一个可选字段」的具体结构体）：手机上
模块各自带着自己的唤醒源，hub 必须能在不认识任何一个模块的前提下说「都去注册」。

**界面那层反过来是具体的**：`DashboardView` 直接认识 `ActivityModule` 并画它的圈。
要是哪天想给协议加一个 `dashboardView()`，那就过线了 —— 每个模块的展示形态本来就
天差地别。

站点那边也要认这个模块名：`src/lib/phone-telemetry.ts` 的 `KNOWN_MODULES`。
没认的模块会原样出现在回执的 `ignored` 里 —— 手机先于站点发版时，那是唯一看得见
这件事的地方。

## 装

```bash
./build-install.sh
```

它做四件事：画图标 → `xcodegen generate` → `xcodebuild` Release → `devicectl` 装到手机。
自动挑那台配对着的 iPhone；挑不出唯一一台时会把候选列出来，用
`IPHONE_HUB_DEVICE=<identifier> ./build-install.sh` 指定。签名走自动，Team 默认
`2VTXNMR2GL`（`IPHONE_HUB_TEAM` 可改）。

`.xcodeproj` **不入库**，是 `project.yml` 生成的 —— 几千行 pbxproj 进版本库只会在每次
改文件时制造无意义的冲突。

第一次打开要做两件事：

1. 允许读取健康数据 —— **六项全勾**。少勾哪项就少哪项，站点那边对应的格子直接不渲染。
2. 右上角齿轮里填上报地址（`https://ingest.homepage.lyjw.llc/api/ingest/iphone`）和
   `TELEMETRY_INGEST_SECRET`，保存，按一次「立刻上报」。密钥存钥匙串，
   `kSecAttrAccessibleAfterFirstUnlock` —— 锁屏状态下被唤醒也要读得到它。

本机联调把地址填成 `http://<Mac 局域网 IP>:3211/api/ingest/iphone` 就行，
Info.plist 里开了 `NSAllowsLocalNetworking`。**别填 `dev.lyjw.me`** —— 那份预览部署
开着 Vercel Authentication，App 的 POST 过不去。

## 签名会过期

装上去那个包是**开发签名**，有寿命。到期之后 iOS 直接拒绝启动它，站点那侧的表现只是
「圆环停在最后一次上报」，不会报任何错 —— 所以值得记一笔。

以「描述文件」和「实际签名用的那张证书」里**先到期的那个**为准，两个都能查：

```bash
# 描述文件
security cms -D -i ~/Library/Developer/Xcode/UserData/Provisioning\ Profiles/*.mobileprovision \
  | plutil -extract ExpirationDate raw -
# 真正签它的那张证书
codesign -dvvv "${TMPDIR:-/tmp}/iphone-telemetry-hub-xcode/Build/Products/Release-iphoneos/iPhoneTelemetryHub.app"
```

2026-08-25 那次装的实测：描述文件到 2027-08-24（一年，付费个人账号的正常时长），
而签名证书只到 2026-10-05 —— **六周，短的是证书**。描述文件里塞着好几张证书，Xcode
挑哪张是它自己的事，那次挑的恰好是最早过期的一张。

到期了**重跑一次 `build-install.sh`** 就行：它会重新挑一张还有效的证书、必要时刷新描述
文件。钥匙串里的密钥和健康授权都留着，不用重新配。

## 装不上的两种

**`No Accounts: Add a new account in Accounts settings`**，跟着一串
「Provisioning profile "iOS Team Provisioning Profile: *" doesn't include the HealthKit
capability」—— 这不是工程配错了，是 **xcodebuild 拿不到开发者账号**，于是退回那份通配的
描述文件，而通配文件里没有 HealthKit 能力。带特殊能力的 bundle id 需要**现申请**一份
自己的描述文件，那一步绕不开账号。

最常见的原因是 **Mac 锁着屏**：登录钥匙串跟着锁上，Xcode 那条账号记录读不出来
（日志里会有 `Invalid credentials in keychain … missing Xcode-Username`）。解锁之后
重跑一般就好了；还不行就打开 Xcode → Settings → Accounts 看那个 Apple ID 要不要重新登。

对照着查：`~/Library/Developer/Xcode/UserData/Provisioning Profiles/` 下有没有一份
`iOS Team Provisioning Profile: com.liangyangjunwei.iPhoneTelemetryHub`。有、且没过期，
就说明账号那关过了。

**`Unable to find a destination matching { id:… }`** —— 手机不在线（锁屏、或者不在同一个
网络里）。`xcrun devicectl list devices` 看 `tunnelState`：`unavailable` 是连不上，
`disconnected` 就已经能装了。

编译**必须对着具体设备**（脚本里就是这么写的）：试过 `generic/platform=iOS`，那样自动
签名会挑通配的描述文件，照样缺 HealthKit 能力。

## 什么时候会上报

- 模块有新数据 → 系统把 App 唤起来 → 报一次。活动圆环这条**按小时节流**：
  `HKObserverQuery` 传 `.immediate` 也会被系统钳到 `.hourly`，别指望分钟级。
- 回到前台 → 报一次。这是唯一能绕开上面那个节流的路子。
- 按「立刻上报」→ 强制报一次，绕开合并窗口和「内容没变」两道闸。

多个唤醒源几乎同时响（活动圆环一个模块就观测着四个 HealthKit 类型），60 秒的窗口把它们
并成一封。内容一个字节没变就不发，除非隔了 6 小时（站点那份快照 TTL 一周，别让它悄悄
过期）。判「变没变」用的是**编码后的字节**，指纹和真正发出去的 body 共用同一个
`JSONEncoder`（`sortedKeys`）—— 两套配置早晚会飘，飘了之后要么每轮白发一遍，要么反过来
把真变化吞掉。

## 两条不能单独改的规矩

1. **失败了不补发。** 站点那侧是「后到的就是对的」、整份替换，没有顺序闸。这里要是加了
   后台重试队列（`URLSession` 的 background 那套），一封迟到的旧报文就会把已经涨上去的
   数按回去。两边是一对，要加一起加。
2. **交差回调必须等上报结束再调。** 早调的话系统认为这次投递处理完了、随时可以挂起实例，
   上报被掐在半路；一次都不调更糟 —— HealthKit 退避几次之后就不再为这个 App 唤醒，
   表现是「装上那天好好的，过几天再也不更新」。

## 后台到底有没有在报

装好那天只能验到「手动按一下能报」——**后台唤醒这条路只有过几个小时才验得出来**，
而它恰好是最容易悄悄坏掉的一环。查法：装好、授权、手动报一次之后，**别开这个 App**，
过几个小时看站点上那张卡（或者再打开 App 看「最近一次上报」）。时间往前走了就说明
后台投递是通的。

一直不动的话，按这个顺序查：

1. **六项健康权限是不是都给了。** 设置 → 隐私与安全性 → 健康 → 遥测中心。少给哪项就
   少哪项数据，全都没给的话连 summary 都读不到。
2. **`com.apple.developer.healthkit.background-delivery` 有没有进描述文件。** 少了这把钥匙
   `enableBackgroundDelivery` 会报授权错误，而前台点一下一切正常 —— 正是这种「装上那天
   好好的」的坏法。重跑一次 `build-install.sh`（自动签名会重新申请描述文件）。
3. **低电量模式。** 开着的时候系统会砍掉后台唤醒。
4. 都不是的话，把 App 从后台划掉再打开一次：唤醒源是在 `didFinishLaunching` 里注册的，
   一次干净的启动会重新注册全部四个类型。

## 日期这件事

`date` 直接从 summary 自己的 `dateComponents` 拼，**不另拿 `Date()` 算** —— 午夜前后
两者会差一天，而「这份数据说的是哪一天」正是站点唯一较真的东西：跨过午夜之后手表上的圈
已经归零，站点手上那份满环说的是昨天，卡片会把它画淡并写明日期。`secondsFromGMT` 一起发，
站点靠它判断手表那边现在是不是还是这一天。
