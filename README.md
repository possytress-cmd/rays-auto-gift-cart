# Shopify 自动满额赠品（Metaobject + Cloudflare App Home）

网店侧通过 **Theme App Extension** 的 `auto-gift-cart.js` 自动增删赠品行；促销数据存放在应用 **Metaobject**（`$app:auto_gift_promotion`，定义在 `shopify.app.toml`）；商家在 **Shopify Admin → 应用 → 本应用** 内使用托管在 **Cloudflare Workers** 的页面，通过 **Direct Admin API**（`shopify:admin/api/graphql.json`）可视化增删改 Metaobject，无需手写 JSON。

## 架构摘要

| 层级 | 作用 |
|------|------|
| `shopify.app.toml` | `embedded = true`、`[access.admin] embedded_app_direct_api_access`、Metaobject 定义与字段、`read_metaobjects,write_metaobjects` scope |
| `worker/public/index.html` | App Home UI：列表 / 新建 / 删除促销（GraphQL `metaobjectUpsert` / `metaobjectDelete`） |
| `worker/src/index.js` | OAuth（`/auth`）、带 `host` 时提供 App Home 静态页 |
| `extensions/.../auto-gift-cart.liquid` | 从 `metaobjects.auto_gift_promotion.values` 输出 `#auto-gift-cart-config` JSON，并加载购物车脚本 |

## 商家操作清单

1. **安装 / 更新权限**：若你刚升级了本仓库（新增 metaobject 与 scope），请在商店 **重新授权/更新应用** 以接受 `read_metaobjects,write_metaobjects`。  
2. **主题**：**在线商店 → 主题 → App embeds**，启用 **「自动满额赠品」**（嵌入块）。  
3. **配置促销**：**Shopify Admin → 应用 → rays-auto-gift-cart**（在后台 iframe 中打开），在页面里管理促销；保存后立即写入 Metaobject。  
4. **赠品价格**：赠品变体须为 **0 元** 或配置 **100% 折扣**，否则 AJAX 加购会按原价计费。

## Cloudflare（Wrangler）

```bash
npm install
cd worker   # 可选；或在根目录用 --config
npx wrangler deploy --config worker/wrangler.toml
```

- `worker/wrangler.toml`：`[assets]` 指向 `public/`（托管 `index.html`）。  
- **Client secret**：`npx wrangler secret put SHOPIFY_CLIENT_SECRET --config worker/wrangler.toml`  
- `SHOPIFY_SCOPES` 已与 `shopify.app.toml` 对齐，供 OAuth 安装链使用。

## 发布应用与扩展

```bash
shopify app deploy
```

## 功能（网店）

1. **多条促销**：每条对应一条 Metaobject；`promotionId` 为 **metaobject handle**（脚本里区分规则）。  
2. **门槛**：与 `/cart.js` 一致的最小货币单位；小计 **排除** `_auto_gift_promo` 行。  
3. **购物车刷新**：拦截含 `/cart` 的 `fetch`、页面显示、`visibilitychange`、`shopify:section:load` 等。  
4. **结账前**：拦截结账链接与表单，先同步再跳转。

## 限制

| 场景 | 说明 |
|------|------|
| App Home 管理页 | 必须在 **Shopify Admin 内嵌打开** 且已加载 App Bridge，`fetch('shopify:admin/api/graphql.json')` 才会自动带会话；单独新标签打开 Worker 裸 URL 无法写 Metaobject。 |
| Liquid 读取 | 使用全局 `metaobjects.auto_gift_promotion.values`（单类型最多约 50 条循环，见 Shopify Liquid 文档）；若类型 handle 与部署不一致需在主题中调整。 |
| 结账域 | 结账页不跑主题脚本；依赖网店侧已写入购物车。 |

## 目录结构

- `shopify.app.toml` — 应用、scope、embedded、Direct API、**`[metaobjects.app.auto_gift_promotion]`**  
- `extensions/auto-gift-promotions/blocks/auto-gift-cart.liquid` — App embed：Metaobject → JSON + 脚本  
- `extensions/auto-gift-promotions/assets/auto-gift-cart.js` — 购物车逻辑  
- `worker/wrangler.toml`、`worker/src/index.js`、`worker/public/index.html` — Cloudflare

## 开发

```bash
shopify app dev
```

按 CLI 提示连接开发店铺；本地 Worker 可与 CLI 隧道联调（注意 `application_url` 与 Dev Dashboard 一致）。
