/**
 * Auto-add/remove free gift cart lines based on configurable promotions.
 * Gift lines use properties._auto_gift_promo (promotion id). Subtotal excludes those lines.
 */
(function () {
  'use strict';

  const CONFIG_EL_ID = 'auto-gift-cart-config';
  const PROP_PROMO = '_auto_gift_promo';
  const PROP_TAG = '_auto_gift';
  const SYNC_DEBOUNCE_MS = 120;
  const FETCH_PATCH_FLAG = '__autoGiftCartPatched';

  function readConfig() {
    const el = document.getElementById(CONFIG_EL_ID);
    if (!el || !el.textContent) return [];
    try {
      const raw = JSON.parse(el.textContent);
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  function centsFromCartItem(item) {
    return typeof item.final_line_price === 'number'
      ? item.final_line_price
      : Math.round(parseFloat(item.final_line_price) * 100) || 0;
  }

  function isGiftLine(item) {
    const p = item.properties || {};
    return String(p[PROP_PROMO] || '').length > 0;
  }

  function merchandiseSubtotalCents(cart) {
    let sum = 0;
    for (const item of cart.items || []) {
      if (isGiftLine(item)) continue;
      sum += centsFromCartItem(item);
    }
    return sum;
  }

  function giftsByPromo(cart) {
    /** @type {Record<string, { key: string, quantity: number, variantId: number }[]>} */
    const map = {};
    for (const item of cart.items || []) {
      if (!isGiftLine(item)) continue;
      const promo = String(item.properties[PROP_PROMO] || '');
      if (!promo) continue;
      if (!map[promo]) map[promo] = [];
      map[promo].push({
        key: item.key,
        quantity: item.quantity,
        variantId: item.variant_id,
      });
    }
    return map;
  }

  let syncQueued = false;
  let syncRunning = false;

  async function fetchCart() {
    const res = await fetch('/cart.js', {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    });
    if (!res.ok) throw new Error('cart.js failed');
    return res.json();
  }

  async function changeLine(lineKey, quantity) {
    const res = await fetch('/cart/change.js', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      credentials: 'same-origin',
      body: JSON.stringify({ id: lineKey, quantity }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'cart/change.js failed');
    return data;
  }

  async function addVariant(variantId, quantity, promoId) {
    const res = await fetch('/cart/add.js', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      credentials: 'same-origin',
      body: JSON.stringify({
        items: [
          {
            id: variantId,
            quantity,
            properties: {
              [PROP_PROMO]: promoId,
              [PROP_TAG]: '1',
            },
          },
        ],
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.description || data.message || 'cart/add.js failed');
    return data;
  }

  async function runSyncOnce() {
    const promotions = readConfig().filter(function (p) {
      return (
        p &&
        p.enabled &&
        p.promotionId &&
        p.variantId &&
        typeof p.thresholdCents === 'number' &&
        p.thresholdCents > 0
      );
    });
    if (!promotions.length) return;

    let cart = await fetchCart();

    for (const promo of promotions) {
      cart = await fetchCart();
      const subtotal = merchandiseSubtotalCents(cart);
      const byPromo = giftsByPromo(cart);
      const qualifies = subtotal >= promo.thresholdCents;
      const variantId = Number(promo.variantId);
      if (!Number.isFinite(variantId)) continue;

      const limitOne = !!promo.limitOne;
      const existing = byPromo[promo.promotionId] || [];
      const totalGiftQty = existing.reduce(function (a, b) {
        return a + b.quantity;
      }, 0);

      if (!qualifies) {
        for (const row of existing) {
          await changeLine(row.key, 0);
        }
        cart = await fetchCart();
        continue;
      }

      const wrongVariant = existing.some(function (row) {
        return Number(row.variantId) !== variantId;
      });
      if (wrongVariant) {
        for (const row of existing) {
          await changeLine(row.key, 0);
        }
        await addVariant(variantId, 1, promo.promotionId);
        cart = await fetchCart();
        continue;
      }

      if (existing.length === 0) {
        await addVariant(variantId, 1, promo.promotionId);
        cart = await fetchCart();
        continue;
      }

      if (limitOne && totalGiftQty !== 1) {
        const keep = existing[0];
        for (let i = 1; i < existing.length; i++) {
          await changeLine(existing[i].key, 0);
        }
        if (keep.quantity !== 1) {
          await changeLine(keep.key, 1);
        }
        cart = await fetchCart();
      }
    }

    document.dispatchEvent(
      new CustomEvent('auto-gift-cart:synced', { detail: { cart } }),
    );
  }

  function scheduleSync() {
    if (syncQueued) return;
    syncQueued = true;
    setTimeout(function () {
      syncQueued = false;
      if (syncRunning) {
        scheduleSync();
        return;
      }
      syncRunning = true;
      runSyncOnce()
        .catch(function () {
          /* avoid breaking checkout */
        })
        .finally(function () {
          syncRunning = false;
        });
    }, SYNC_DEBOUNCE_MS);
  }

  function patchFetch() {
    if (window[FETCH_PATCH_FLAG]) return;
    window[FETCH_PATCH_FLAG] = true;
    const orig = window.fetch.bind(window);
    window.fetch = function () {
      /** @type {Promise<Response>} */
      const p = orig.apply(this, arguments);
      return p.then(function (res) {
        try {
          const req = arguments[0];
          const url =
            typeof req === 'string'
              ? req
              : req && req.url
                ? req.url
                : '';
          if (
            url.indexOf('/cart') !== -1 &&
            (url.indexOf('.js') !== -1 ||
              url.indexOf('/cart/add') !== -1 ||
              url.indexOf('/cart/change') !== -1 ||
              url.indexOf('/cart/update') !== -1 ||
              url.indexOf('/cart/clear') !== -1)
          ) {
            scheduleSync();
          }
        } catch (_) {
          /* */
        }
        return res;
      });
    };
  }

  function goCheckoutFromEl(el) {
    if (el instanceof HTMLAnchorElement) {
      window.location.href = el.href || '/checkout';
      return;
    }
    if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) {
      const form = el.form;
      const fa = el.formAction;
      if (fa && fa.indexOf('checkout') !== -1) {
        window.location.href = fa;
        return;
      }
      if (form && (form.action || '').indexOf('checkout') !== -1) {
        HTMLFormElement.prototype.submit.call(form);
        return;
      }
    }
    window.location.href = '/checkout';
  }

  function interceptCheckout() {
    document.addEventListener(
      'click',
      function (e) {
        const t = /** @type {HTMLElement | null} */ (e.target);
        if (!t || !t.closest) return;
        const el = t.closest(
          'a[href*="/checkout"], button[name="checkout"], input[name="checkout"]',
        );
        if (!el) return;
        if (el instanceof HTMLAnchorElement) {
          const href = el.getAttribute('href') || '';
          if (
            href.indexOf('/checkout') === -1 &&
            href.indexOf('checkout.shopify.com') === -1
          ) {
            return;
          }
        }
        e.preventDefault();
        e.stopPropagation();
        runSyncOnce()
          .catch(function () {})
          .finally(function () {
            goCheckoutFromEl(/** @type {HTMLElement} */ (el));
          });
      },
      true,
    );

    document.addEventListener(
      'submit',
      function (e) {
        const form = e.target;
        if (!(form instanceof HTMLFormElement)) return;
        let dest = form.action || '';
        const active = document.activeElement;
        if (
          active instanceof HTMLButtonElement ||
          active instanceof HTMLInputElement
        ) {
          if (active.formAction) dest = active.formAction;
        }
        if (dest.toLowerCase().indexOf('checkout') === -1) return;
        e.preventDefault();
        runSyncOnce()
          .catch(function () {})
          .finally(function () {
            HTMLFormElement.prototype.submit.call(form);
          });
      },
      true,
    );
  }

  function boot() {
    patchFetch();
    interceptCheckout();
    scheduleSync();
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') scheduleSync();
    });
    window.addEventListener('pageshow', function () {
      scheduleSync();
    });
    document.addEventListener('shopify:section:load', function () {
      scheduleSync();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
