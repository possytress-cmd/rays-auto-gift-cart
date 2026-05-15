/**
 * Cloudflare Worker: OAuth + static App Home (embedded admin UI in /public).
 */

const COOKIE_STATE = 'shopify_oauth_state';

function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function redirect(location, extraHeaders = {}) {
  return new Response(null, {
    status: 302,
    headers: { location, ...extraHeaders },
  });
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  const bytes = new Uint8Array(sig);
  return [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function verifyShopifyInstallHmac(query, clientSecret) {
  const hmac = query.hmac;
  if (!hmac) return false;
  const keys = Object.keys(query)
    .filter((k) => k !== 'hmac' && k !== 'signature')
    .filter((k) => query[k] !== undefined && query[k] !== '')
    .sort();
  const message = keys.map((k) => `${k}=${query[k]}`).join('&');
  const digest = await hmacSha256Hex(clientSecret, message);
  return timingSafeEqual(digest.toLowerCase(), String(hmac).toLowerCase());
}

function parseCookies(header) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function normalizeShop(shop) {
  if (!shop) return '';
  const s = String(shop).trim().toLowerCase();
  if (!s.endsWith('.myshopify.com')) return '';
  return s;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default {
  /**
   * @param {Request} request
   * @param {{ ASSETS?: Fetcher; SHOPIFY_CLIENT_ID: string; SHOPIFY_CLIENT_SECRET?: string; SHOPIFY_SCOPES?: string }} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    const rawPath = url.pathname;
    const path = rawPath.replace(/\/$/, '') || '/';

    if (request.method === 'GET' && path === '/' && url.searchParams.get('host') && env.ASSETS) {
      const u = new URL(request.url);
      u.pathname = '/index.html';
      return env.ASSETS.fetch(new Request(u, request));
    }

    if (env.ASSETS && !path.startsWith('/auth')) {
      const assetRes = await env.ASSETS.fetch(request);
      if (assetRes.status !== 404) return assetRes;
    }

    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }

    if (path === '/' || path === '') {
      return htmlResponse(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>rays-auto-gift-cart</title></head><body>
        <h1>rays-auto-gift-cart</h1>
        <p>从 Shopify Admin 打开本应用以管理促销；或完成 OAuth 安装：<a href="/auth?shop=你的店铺.myshopify.com">/auth?shop=…</a></p>
        </body></html>`,
      );
    }

    if (path === '/auth') {
      const shop = normalizeShop(url.searchParams.get('shop'));
      if (!shop) {
        return htmlResponse(
          '<p>缺少 <code>shop</code> 参数。示例：<code>/auth?shop=your-store.myshopify.com</code></p>',
          400,
        );
      }
      if (!env.SHOPIFY_CLIENT_ID || env.SHOPIFY_CLIENT_ID.startsWith('REPLACE_')) {
        return htmlResponse(
          '<p>请在 <code>worker/wrangler.toml</code> 的 <code>[vars]</code> 中设置 <code>SHOPIFY_CLIENT_ID</code>。</p>',
          500,
        );
      }
      const state = crypto.randomUUID();
      const redirectUri = `${url.origin}/auth/callback`;
      const scopes = env.SHOPIFY_SCOPES || '';
      const u = new URL(`https://${shop}/admin/oauth/authorize`);
      u.searchParams.set('client_id', env.SHOPIFY_CLIENT_ID);
      if (scopes) u.searchParams.set('scope', scopes);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('state', state);
      return redirect(u.toString(), {
        'set-cookie': `${COOKIE_STATE}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      });
    }

    if (path === '/auth/callback') {
      const secret = env.SHOPIFY_CLIENT_SECRET;
      if (!secret) {
        return htmlResponse(
          '<p>未配置 <code>SHOPIFY_CLIENT_SECRET</code>。请执行 <code>wrangler secret put SHOPIFY_CLIENT_SECRET --config worker/wrangler.toml</code></p>',
          500,
        );
      }

      /** @type {Record<string, string>} */
      const q = {};
      for (const [k, v] of url.searchParams.entries()) q[k] = v;

      const cookies = parseCookies(request.headers.get('cookie') || '');
      if (!q.state || q.state !== cookies[COOKIE_STATE]) {
        return htmlResponse('<p>无效的 OAuth state（请重试安装）。</p>', 403);
      }

      const okHmac = await verifyShopifyInstallHmac(q, secret);
      if (!okHmac) {
        return htmlResponse('<p>HMAC 校验失败。</p>', 403);
      }

      const shop = normalizeShop(q.shop);
      if (!shop || !q.code) {
        return htmlResponse('<p>缺少 shop 或 code。</p>', 400);
      }

      const tokenUrl = `https://${shop}/admin/oauth/access_token`;
      const tokenRes = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          client_id: env.SHOPIFY_CLIENT_ID,
          client_secret: secret,
          code: q.code,
        }),
      });
      const tokenJson = await tokenRes.json().catch(() => ({}));
      if (!tokenRes.ok || !tokenJson.access_token) {
        return htmlResponse(
          `<p>换取 access token 失败（${tokenRes.status}）。</p><pre>${escapeHtml(
            JSON.stringify(tokenJson, null, 2),
          )}</pre>`,
          502,
        );
      }

      return new Response(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>已授权</title></head><body>
        <h1>OAuth 完成</h1>
        <p>店铺：<strong>${escapeHtml(shop)}</strong></p>
        <p>请在 Shopify Admin → 应用 → rays-auto-gift-cart 中打开应用，使用「满额赠品」界面管理促销。</p>
        </body></html>`,
        {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'set-cookie': `${COOKIE_STATE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
            'cache-control': 'no-store',
          },
        },
      );
    }

    return new Response('Not found', { status: 404 });
  },
};
