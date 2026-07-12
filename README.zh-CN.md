# Ratatoskr

[English](README.md) | 简体中文

一个运行在 Cloudflare Workers 上的最小 Yggdrasil 认证服务与皮肤服务，配合
[authlib-injector](https://github.com/yushijinhun/authlib-injector) 使用。

- Workers 提供 API，D1 存储账号、角色与令牌，KV 存储皮肤图像与进服记录。
- 皮肤按 SHA-256 内容寻址，相同图像自动去重，材质 URL 可长期缓存。
- 材质属性使用 RSA 签名（`SHA1withRSA`）。Minecraft 服务端在信任皮肤 URL 之前会校验该
  签名，这是协议的强制要求。
- 密码由服务器生成，用户不可自选，详见[密码](#密码)。
- 注册需要一次性邀请码，详见[邀请码](#邀请码)。
- 附带一个用于注册、登录与皮肤管理的网页界面，支持中英文。第一个账号即管理员，可在其中
  看到[管理视图](#管理)。

## 部署

```bash
npm install
npx wrangler login
npm run setup
```

`setup` 会创建 D1 数据库与 KV 命名空间，将其 id 写回 `wrangler.jsonc`，执行数据库迁移，
生成 RSA 密钥并存为 `SIGNING_KEY`，完成部署，然后询问管理员的邮箱与角色名并创建该账号，
其密码只打印一次。该命令可重复执行：已存在的资源会被复用，不会重建，也不会创建第二个
管理员。

用该账号登录站点即可进入管理视图，邀请码在那里签发。

后续部署：

```bash
npm run deploy
```

### 自定义域名

在 `wrangler.jsonc` 中加上域名并重新部署即可。该域名需要位于同一个 Cloudflare 账号下：

```jsonc
"routes": [{ "pattern": "auth.example.com", "custom_domain": true }]
```

除此之外无需任何改动。`PUBLIC_URL` 可以继续留空：元数据文档的 origin —— 以及它写入
`skinDomains` 的条目、它签名的材质 URL —— 都取自请求本身的主机名，因此同一个 Worker 在
`workers.dev` 与自定义域名下都能正确应答。

仅当 origin 必须固定、不随请求主机变化时才需要设置 `PUBLIC_URL`：例如位于反向代理之后，
或希望正式域名上线后材质 URL 中不再出现 `workers.dev` 主机名。

```jsonc
"vars": { "PUBLIC_URL": "https://auth.example.com" }
```

更换域名是安全的——材质签名是每次请求现签的，并不存库——但玩家需要在启动器中更新认证服务器
地址，服务端也需要更新 `-javaagent` 参数。

## 使用

在启动器中将下列地址添加为外置认证服务器：

```
https://<你的-worker-地址>/api/yggdrasil
```

在 Minecraft 服务端为 JVM 挂载 authlib-injector：

```bash
-javaagent:authlib-injector.jar=https://<你的-worker-地址>/api/yggdrasil
```

`server.properties` 中有两项设置是关键：

- `online-mode=true`：只有开启时认证才会生效。
- `enforce-secure-profile=false`：必须关闭。聊天签名依赖 Mojang 的 `/minecraftservices`
  证书接口，本服务未实现该部分。

## 接口

Yggdrasil API 位于 `/api/yggdrasil` 之下：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/yggdrasil` | 元数据文档，即客户端所填写的地址 |
| POST | `/api/yggdrasil/authserver/authenticate` | 使用邮箱地址或角色名登录 |
| POST | `/api/yggdrasil/authserver/refresh` | 签发新令牌并作废原令牌 |
| POST | `/api/yggdrasil/authserver/validate` | 校验令牌是否仍然有效 |
| POST | `/api/yggdrasil/authserver/invalidate` | 作废单个令牌 |
| POST | `/api/yggdrasil/authserver/signout` | 作废账号名下全部令牌 |
| POST | `/api/yggdrasil/sessionserver/session/minecraft/join` | 客户端进服请求 |
| GET | `/api/yggdrasil/sessionserver/session/minecraft/hasJoined` | 服务端校验，返回带签名的角色 |
| GET | `/api/yggdrasil/sessionserver/session/minecraft/profile/{uuid}` | 查询角色，`?unsigned=false` 附带签名 |
| POST | `/api/yggdrasil/api/profiles/minecraft` | 按角色名批量解析 UUID，单次最多 10 个 |
| PUT | `/api/yggdrasil/api/user/profile/{uuid}/{skin\|cape}` | 上传材质（Bearer 令牌，`multipart/form-data`） |
| DELETE | `/api/yggdrasil/api/user/profile/{uuid}/{skin\|cape}` | 移除材质 |

Yggdrasil 命名空间之外：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/register` | 注册账号，消耗一个一次性邀请码，返回仅显示一次的生成密码 |
| GET | `/textures/{sha256}` | 获取材质 |
| GET | `/` | 网页界面 |

管理接口，均需在 Bearer 中携带管理员的 access token：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/state` | 一次性返回全部账号与全部邀请码 |
| POST | `/api/admin/invites` | 签发邀请码，`{ count?, note? }`，单次最多 20 个 |
| DELETE | `/api/admin/invites/{code}` | 撤销一个未使用的邀请码 |
| POST | `/api/admin/accounts/{uuid}/password` | 签发新密码（仅返回一次），并登出该账号 |
| DELETE | `/api/admin/accounts/{uuid}` | 删除账号及其角色 |

## 配置

`wrangler.jsonc` 中的变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SERVER_NAME` | `Ratatoskr` | 元数据文档中显示的服务名 |
| `PUBLIC_URL` | 空 | 对外地址。留空时从请求推断，通常无需填写 |
| `SKIN_DOMAINS` | 空 | 允许提供材质的额外主机名，以逗号分隔。本服务自身的主机名始终包含在内 |

只有一个 secret，由 `setup` 设置：`SIGNING_KEY`，即 PKCS#8 PEM 格式的 RSA 私钥。

## 管理

管理员就是一个带 `is_admin` 标记的普通账号——同样的登录方式、同样的令牌、在游戏里同样是
一个角色。它只是那个"没有人能邀请"的账号，因此由 `setup` 直接创建，而不是注册出来的。

用它登录后，站点上会出现**管理**一节：

- **邀请码** —— 签发邀请码（可附备注，记录发给了谁）、查看哪些码尚未使用、撤销未使用的码。
- **账号** —— 查看全部账号及其角色，为某个账号签发新密码，或删除某个账号。

重置密码会登出该账号的所有会话，并将新密码显示一次。删除账号会一并删除其角色并释放该名称。
管理员不能删除自己的账号：若这是最后一个管理员，服务将无人可管。

视图背后的接口位于 `/api/admin`，凭据就是管理员本人的 Yggdrasil access token，无需管理
第二种凭据。

### 命令行

上述操作同样都有对应的脚本；万一管理员遗失密码，这就是重新进入的途径。加 `--local` 可对
本地开发数据库执行。

```bash
npm run invite                      # 签发一个邀请码
npm run invite -- 5                 # 一次签发五个
npm run invite -- --note "给小明"    # 附上备注，记录发给了谁
npm run invite -- --list            # 列出全部邀请码，未使用的在前
npm run invite -- --revoke <code>   # 撤销一个尚未使用的邀请码
npm run reset-password -- Steve     # 为某个角色签发新密码
npm run create-admin -- <邮箱> <角色名>
```

若要把一个已有账号提升为管理员，而不是新建：

```bash
npx wrangler d1 execute ratatoskr --remote \
  --command "UPDATE users SET is_admin = 1 WHERE email_lower = 'someone@example.com';"
```

## 邀请码

注册仅对持有邀请码的人开放，且**一个邀请码会被它所创建的账号消耗掉**。邀请码存放在数据库
中，而非某个 secret，因此发出一个邀请码至多只能换来一次注册，也无需轮换。

邀请码为 16 位 Crockford base32 字符，每四位一组（`qmjb-cvbd-feyf-drbw`）。该字母表不含
`i`、`l`、`o`、`u`，因此可以口述而不产生歧义。只有未使用的邀请码可以撤销：删除一个已使用
的邀请码，会使它能够被再次兑换。

## 密码

**用户不能自选密码。** 注册时服务器生成一个 20 字符、约 100 bit 熵的随机密码，形如
`k7rm-9xqt-2vhw-4pbd-6nzc`，并在注册响应中返回一次，此后不再显示。

这是一项有意的取舍。PBKDF2 之类的慢速密钥派生函数，其存在意义是弥补人类所选密码的低熵：
候选空间小，因此必须让每次猜测变得昂贵。而 100 bit 的随机密码对应 2¹⁰⁰ 的候选空间，
攻击者即便持有泄露的数据库，也无法穷举，与哈希的快慢无关。因此密码以**加盐的单轮
SHA-256** 存储。这省去了 KDF 所需的数毫秒 CPU（Workers 免费版每个请求仅有 10 ms CPU），
相关代码量也减少了一半。

代价是密码遗失后无法找回，只能重新签发。这是管理员的职责——可以在管理视图里操作，也可以走
命令行：

```bash
npm run reset-password -- Steve
```

两种方式都会登出该账号的全部会话，并将新密码显示一次。

> **注意**
> 若日后要加入"自选密码"或"修改密码"功能，**必须重新引入 PBKDF2**（约 600000 轮）。
> 上述论证完全依赖于"不存在任何可写入弱密码的路径"这一前提。哈希带有方案前缀
> （`sha256$…`），两种方案可以共存，已有账号不受影响。该不变量记录在
> `src/lib/crypto.ts` 顶部的注释中。

## 本地开发

```bash
npm run keygen > key.pem
printf 'SIGNING_KEY="%s"\n' "$(sed -z 's/\n/\\n/g' key.pem)" > .dev.vars
npm run migrate:local
npm run create-admin -- dev@example.com Dev --local
npm run dev
```

用该账号登录后即可在管理视图中签发邀请码，或直接执行 `npm run invite -- --local`。

## 已知限制

- 每个账号仅有一个角色。数据库结构支持更多，但 API 未开放。
- 移除皮肤只会清除角色上的引用，图像仍保留在 KV 中。由于图像按内容寻址，其他角色可能仍
  指向同一份数据。这会遗留少量孤儿数据，如有需要可另行编写清理任务。
- 未实现 `/minecraftservices` 相关接口（玩家证书与聊天签名），因此服务端必须以
  `enforce-secure-profile=false` 运行。
- API 返回的错误消息一律为英文，因为 Yggdrasil 协议会将其直接展示给游戏客户端。网页界面
  按原样显示这些消息。
