# Glados自动签到

## 食用方式：

### 注册一个GLaDOS的账号([注册地址](https://glados.space/landing/0A58E-NV28S-6U3QV-33VMG))

#### 我的邀请码：([0A58E-NV28S-6U3QV-33VMG](https://0a58e-nv28s-6u3qv-33vmg.glados.space)) 

#### 我的优惠码（9折）：([DEVILSTORE](https://0a58e-nv28s-6u3qv-33vmg.glados.space)) 

### **Fork**本仓库

![图片加载失败](imgs/1.png)

### 添加**secret**

1. 跳转至自己的仓库的`Settings`->`Secrets and variables`->`Action`

2. 添加1个`repository secret`，命名为`GLADOS_COOKIES`，其值对应GLaDOS账号的cookie值中的有效部分（获取方式如下）

- 在GLaDOS的签到页面按`F12`

- 切换到`Network`页面下，刷新

![图片加载失败](imgs/2.png)

- 点击第一个选项卡后在`Request Headers`下找到`Cookie`，右键复制cookie的值即可

  > 参考格式：koa:sess=eyJ1c2xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxAwMH0=; koa:sess.sig=xJkOxxxxxxxxxxxxxxxtnM;

![图片加载失败](imgs/3.png)

- 多账号请在 `COOKIES` 中 添加多个 `cookies` 中间使用 `&`连接即可。（例如： `c1&c3&c3...`）

3. 配置积分兑换策略（非必须）

- 添加1个`repository secret`，命名为`GLADOS_EXCHANGE_PLAN`，配置自动兑换积分策略：

| 值 | 积分要求 | 兑换天数 |
|---|---------|---------|
| `plan100` | 100 积分 | 10 天 |
| `plan200` | 200 积分 | 30 天 |
| `plan500` | 500 积分 | 100 天 |

> GitHub Actions 默认使用 `plan500`：每个账号达到 500 积分后自动兑换 100 天，积分不足或查询失败时跳过。可设置 `GLADOS_EXCHANGE_PLAN` 为 `plan100` / `plan200` / `plan500` 覆盖此默认值；设置为 `none` 可关闭自动兑换。本地运行未设置该变量时仍默认不兑换。

4. 手机推送（非必须）

- 在 [PushPlus 官网](https://www.pushplus.plus/) 获取自己的 Token，并按网站提示绑定通知接收渠道。
- 添加1个 `repository secret`，命名为 `PUSHPLUS_TOKEN`，值填入 PushPlus Token。Token 只需在 GitHub Secrets 中保存，不要写入代码或日志。
- 配置后，每次运行都会发送签到汇总，包括成功、重复签到和失败；未配置时跳过通知。迁移后不再使用 `PUSHDEER_SENDKEY`。
- GitHub Actions 默认使用 `cmcc`（中国移动新消息ClawBot）渠道，发送纯文本汇总。请先在 PushPlus 官网的“个人中心 → 渠道配置 → 新消息ClawBot”中完成 Channel API Key 绑定，并发送测试消息确认能收到。Channel API Key 保存在 PushPlus，GitHub 的 `PUSHPLUS_TOKEN` 仍填 PushPlus Token。
- 如需其他渠道，可在仓库 `Settings → Secrets and variables → Actions → Variables` 中添加 `PUSHPLUS_CHANNEL`（例如 `wechat`、`app`、`webhook`、`mail`）。对应渠道需要配置编码时，再添加 `PUSHPLUS_OPTION`，填写 PushPlus 中的渠道编码；`cmcc` 不需要该参数。
- 本地运行未设置 `PUSHPLUS_CHANNEL` 时，使用 PushPlus 账户中配置的默认渠道。消息发送是异步的，接口接受请求不表示已经送达；日志会记录消息流水号，可在 PushPlus 查询最终发送结果。详见 [cmcc 官方教程](https://github.com/pushplus/pushplus/blob/main/channel/cmcc.md)。
- 在 Actions 中手动运行 `auto check`，日志出现“PushPlus 推送请求已提交”表示接口已接受请求；实际送达请在接收渠道或 PushPlus 后台确认。

### **star**自己的仓库

![图片加载失败](imgs/4.png)

## 文件结构

```shell
│  checkin.py	# 签到脚本
│
├─.github
│  └─workflows
│          gladosCheck.yml	# Actions 配置文件
```

## 更新日志

- **2026-01**: 重构代码，添加log输出方便定位，支持新版网址，支持配置积分兑换策略。
- **2026-04**: 优化代码逻辑，优化日志输出，支持[新版域名](https://railgun.info) ，在 GLADOS_COOKIES 中添加新版域名下的 cookies 即可使用。
- **2026-09**: 新增设备平台自适应重试（code 4 无需手动配置 UA 即可自动恢复）；默认关闭自动兑换，需显式配置 `GLADOS_EXCHANGE_PLAN` 才启用。
- **2026-09**: 新增网络层重试/退避：`requests.Session` 挂载 `HTTPAdapter` + `urllib3.Retry`（total=3、指数退避 1/2/4s、对 429/5xx 自动重试），降低 CI 网络抖动导致的误报失败；业务 200 响应不受影响。


## 问题排查与定位
- 大家可以通过查询 actions 中的 running checkin 日志快速定位问题，有其他问题提交issue。
- 若日志出现 `code : 4, message : Automated check-in detected`：这是 GLaDOS 的**设备平台校验**（`reason=device-mismatch`，即签到请求 UA 平台与登录设备平台不一致）。脚本已内置**设备平台自适应**：首次失败时自动读取服务端返回的 `loginDevice` 并切换对应平台 UA 重试，**无需手动配置 User-Agent**；若长期仍失败，请重新登录 glados.cloud 手动签到一次并刷新 cookie。

  <img width="1684" height="844" alt="image" src="https://github.com/user-attachments/assets/45348a5f-43e4-45f5-8fdf-ce84d343b30d" />

## 声明

本项目不保证稳定运行与更新, 因GitHub相关规定可能会删库, 请注意备份







