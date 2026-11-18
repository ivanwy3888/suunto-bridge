# 颂拓记录搬家 · Suunto Bridge

把 **颂拓中国区账号** 里的运动记录，搬到你的 **颂拓国际区账号**。Mac 桌面程序，界面在本地，密码和钥匙不经过任何第三方。

> Move your Suunto China activities to your Suunto international account via your own FitnessSyncer account. macOS app, local-first.

## 它做什么

颂拓中国区（`api.suunto.cn`）和国际区（`api.sports-tracker.com`）是两套互不相通的账号，官方没有迁移入口，App 里只能一条一条导出。这个程序把三段流程做成三个选项卡：

| 选项卡 | 做什么 |
| --- | --- |
| ① 下载记录 | 登录中国区账号，按「全部」或「指定时间段」把每条活动的原始 `.fit` 存到你的文件夹，并生成「导出清单.csv」 |
| ② 上传到 FitnessSyncer | 用你自己的 FitnessSyncer 个人应用凭据登录授权，把文件夹里的 `.fit` 全部传进 FitnessSyncer 的 Notebook |
| ③ 传到颂拓国际 | 在 FitnessSyncer 里建好到颂拓国际的接收方，触发同步，由 FitnessSyncer 把记录送进你的国际区账号 |

第四个选项卡是给第一次用的人看的使用说明。

中途停止、关掉程序都没关系：已下好的文件会跳过，已传过的文件名记在文件夹里的「已上传.txt」。

## 为什么需要绕这一圈

导出是读接口，登录就能做；写进颂拓要合作方资格，自己拼请求进不去。FitnessSyncer 是颂拓官方合作方之一，能代你把活动写进国际区账号，所以中间借它中转一次。

## 下载安装

到 [Releases](../../releases) 下载最新的 `.dmg`，打开后把「颂拓记录搬家」拖进「应用程序」。

- 需要 **macOS 13 或更高**，目前发布的是 **Apple 芯片（M1 及以后）** 版本。
- 没有做 Apple 开发者签名和公证，**第一次打开要右键点图标 →「打开」→ 再点一次「打开」**。直接双击会被系统拦住。

## 用之前准备好

- 中国区颂拓账号的**注册邮箱**和密码（手机号登不进去）
- FitnessSyncer 免费账号
- 你自己的 FitnessSyncer「个人应用程序」的**客户端 ID 和客户端密钥**（见下）
- 颂拓国际区账号；没有也不要紧，第三选项卡的窗口里可以注册

### 拿自己的那对钥匙

打开 <https://www.fitnesssyncer.com/account/developer?lang=zh>，在「创建应用程序」里类型选「个人应用程序」，点「创建」；创建完表格里多出一行，点开就能看到客户端 ID 和客户端密钥，两串复制到程序的第二个选项卡里保存。

**每人用自己的一对。** 这串 ID 只代表「是哪个程序在请求」，令牌属于在弹窗里登录同意的那个人，记录进的是那个人的 FitnessSyncer 账号。不要共用别人的应用凭据：密钥发出去收不回，别人出了事也算在凭据主人名下。

## 凭据放在哪

程序不写死任何人的凭据，也不上传到别处。全部只在这台电脑上：

| 内容 | 位置 |
| --- | --- |
| 中国区会话 | `~/Library/Application Support/SuuntoBridge/session-cn.json` |
| 中国区账号信息 | `~/.config/suuntool/cn.json`（由 suuntool 维护） |
| FitnessSyncer 钥匙与令牌 | `~/Library/Application Support/SuuntoBridge/fs-oauth.json`（权限 0600） |
| 已上传台账 | 你选的记录文件夹里的「已上传.txt」 |

颂拓密码只交给颂拓服务器，程序不留存；FitnessSyncer 的密钥只用于换令牌。

## 已知限制

- **同步只送「上次同步之后」的新活动。** FitnessSyncer 记的是时间水位线，不是逐条账本：补传一条更旧日期的活动，不会被再送到颂拓国际，先点同步再补传也会漏。第一次搬家因为还没同步过，所以历史记录能全过。
- **日期范围只能在 FitnessSyncer 网站的目的地 Filters 里设**，接口不支持，程序里不放假的日期框。
- **不核对目的地已有条目**，手表直传国际区的同一条记录可能与同步过来的并存；重复了在颂拓 App 里看条数。
- 上传不去重：同一文件传两次就是两条，多出来的在 FitnessSyncer 网站里删。
- 中间要重新编码两次（FIT → FitnessSyncer 条目 → 颂拓），**不会逐字节一致**。
- **会过去**：GPS 轨迹、逐点心率和速度/海拔/步频/功率/温度、每圈数据、总距离/时长/爬升下降/卡路里/平均最大心率、运动类型、开始时间。
- **会丢**：步数、TSS、训练负荷、EPOC、恢复时间、主观感觉等颂拓自算衍生值，SuuntoPlus 自定义字段，装备绑定，长备注。

## 从源码构建

要求：macOS 13+、Xcode Command Line Tools（`xcode-select --install`）、底层工具 [suuntool](https://github.com/tajchert/suuntool)。

```sh
# 1. 装 suuntool（MIT，作者 Michal Tajchert）
brew install --cask tajchert/tap/suuntool

# 2. 放进资源目录
mkdir -p SuuntoBridge/Resources/bin
cp "$(command -v suuntool)" SuuntoBridge/Resources/bin/suuntool

# 3. 构建
cd SuuntoBridge && ./build.sh
```

产物是 `SuuntoBridge/build/颂拓记录搬家.app`。打包 dmg：

```sh
mkdir -p /tmp/dmg && cp -R build/颂拓记录搬家.app /tmp/dmg/ && ln -s /Applications /tmp/dmg/应用程序
hdiutil create -volname 颂拓记录搬家 -srcfolder /tmp/dmg -fs HFS+ -format UDZO 颂拓记录搬家.dmg
```

## 常见问题

- **登录说密码不对**：要用注册邮箱，手机号不行；忘了密码去颂拓网站找回。
- **第二步报 401 / 403**：FitnessSyncer 授权过期，回第二个选项卡重新点「登录并授权」。
- **第三步一直排队**：服务器在排队，等几分钟；按钮变成「重新检查」时点一下重读。
- **传重复了**：同一场活动两条，在 FitnessSyncer 网站删掉多余那条。

## 致谢

本项目的底层取数与登录能力来自 **suuntool**：

- [tajchert/suuntool](https://github.com/tajchert/suuntool) © Michal Tajchert，MIT License（全文见 [NOTICE.md](NOTICE.md)）

以及：

- [FitnessSyncer 开发者文档](https://www.fitnesssyncer.com/developers)，OAuth2 授权与数据接口的规则均按其文档实现
- 界面、图标与说明页为本项目自制，界面字体使用系统自带的苹方 / Hiragino Sans GB 渲染

本项目与 Suunto、FitnessSyncer 没有任何隶属或背书关系，相关名称和商标归各自所有者。

## 许可证

[MIT](LICENSE)

## 免责声明

这是第三方工具，按现状提供，不对数据迁移的完整性和结果负责。使用前请确认自己有权导出和搬移这些记录。