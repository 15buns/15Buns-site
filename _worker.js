/**
 * 15 Buns — _worker.js
 * -------------------------------------------------------------
 * ملف واحد يتحكم بكل شي:
 *   - يخدم الموقع (index.html) ولوحة التحكم (admin.html) من مجلد /site
 *   - يعالج كل طلبات API (/api/*)
 *   - يخدم الصور المرفوعة من لوحة التحكم (/images/*) من R2
 *
 * هذا الملف يشتغل كمشروع Cloudflare Pages بوضع "Advanced Mode"
 * (يعني يتحكم بكل الطلبات بنفسه، بدون Pages Functions ولا Wrangler).
 *
 * لازم تربط من إعدادات المشروع (Settings > Functions):
 *  - KV namespace binding:  MENU_KV
 *  - R2 bucket binding:     MENU_IMAGES
 *  - Environment variable (Secret): ADMIN_PASSWORD
 * -------------------------------------------------------------
 */

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}
function notFound() { return json({ error: "not_found" }, 404); }
function unauthorized() { return json({ error: "unauthorized" }, 401); }

function isAuthed(request, storedPassword) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  return token && storedPassword && token === storedPassword;
}

async function getJSON(env, key, fallback) {
  const val = await env.MENU_KV.get(key);
  if (!val) return fallback;
  try { return JSON.parse(val); } catch { return fallback; }
}
async function putJSON(env, key, value) {
  await env.MENU_KV.put(key, JSON.stringify(value));
}

const DEFAULTS = {
  products: [],
  categories: [],
  settings: {
    restaurantName: "15 Buns",
    whatsapp: "",
    currency: "د.أ",
    discountThreshold: 10,
    discountAmount: 10,
    logo: "",
  },
  gallery: [],
  analytics: { pageViews: 0, whatsappOrders: 0, daily: {} },
};

function uid() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  // ---------- Public: full menu data for the live site ----------
  if (path === "/api/menu" && method === "GET") {
    const [products, categories, settings] = await Promise.all([
      getJSON(env, "products", DEFAULTS.products),
      getJSON(env, "categories", DEFAULTS.categories),
      getJSON(env, "settings", DEFAULTS.settings),
    ]);
    return json({ products, categories, settings });
  }

  // ---------- Public: track events ----------
  if (path === "/api/track" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const analytics = await getJSON(env, "analytics", DEFAULTS.analytics);
    const today = new Date().toISOString().slice(0, 10);
    analytics.daily[today] = analytics.daily[today] || { pageViews: 0, whatsappOrders: 0 };
    if (body.event === "page_view") { analytics.pageViews++; analytics.daily[today].pageViews++; }
    else if (body.event === "whatsapp_order") { analytics.whatsappOrders++; analytics.daily[today].whatsappOrders++; }
    await putJSON(env, "analytics", analytics);
    return json({ ok: true });
  }

  // ---------- Login (أول مرة بتسجل فيها، كلمة السر يلي بتكتبها بتتسجل تلقائيًا) ----------
  if (path === "/api/login" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const storedPassword = await env.MENU_KV.get("admin_password");
    if (!body.password) return unauthorized();

    if (!storedPassword) {
      // أول مرة: نخزن كلمة السر يلي كتبها كأول مرة كلمة سر لوحة التحكم
      await env.MENU_KV.put("admin_password", body.password);
      return json({ token: body.password, firstSetup: true });
    }
    if (body.password === storedPassword) {
      return json({ token: body.password });
    }
    return unauthorized();
  }

  // ---------- Everything below requires auth ----------
  if (path.startsWith("/api/admin/")) {
    const storedPassword = await env.MENU_KV.get("admin_password");
    if (!isAuthed(request, storedPassword)) return unauthorized();

    if (path === "/api/admin/summary" && method === "GET") {
      const [products, categories, gallery, analytics] = await Promise.all([
        getJSON(env, "products", DEFAULTS.products),
        getJSON(env, "categories", DEFAULTS.categories),
        getJSON(env, "gallery", DEFAULTS.gallery),
        getJSON(env, "analytics", DEFAULTS.analytics),
      ]);
      return json({
        productsCount: products.length,
        categoriesCount: categories.length,
        galleryCount: gallery.length,
        pageViews: analytics.pageViews,
        whatsappOrders: analytics.whatsappOrders,
      });
    }

    // Products CRUD
    if (path === "/api/admin/products" && method === "GET") {
      return json(await getJSON(env, "products", DEFAULTS.products));
    }
    if (path === "/api/admin/products" && method === "POST") {
      const body = await request.json();
      const products = await getJSON(env, "products", DEFAULTS.products);
      const product = {
        id: body.id || uid(),
        category: body.category || "",
        price: Number(body.price) || 0,
        addonPrices: body.addonPrices || [],
        img: body.img || "",
        bestseller: !!body.bestseller,
        active: body.active !== false,
        order: body.order || products.length,
        ar: {
          name: body.ar?.name || "",
          desc: body.ar?.desc || "",
          removals: body.ar?.removals || [],
          addons: body.ar?.addons || [],
        },
      };
      products.push(product);
      await putJSON(env, "products", products);
      return json(product, 201);
    }
    if (path.startsWith("/api/admin/products/") && method === "PUT") {
      const id = path.split("/").pop();
      const body = await request.json();
      const products = await getJSON(env, "products", DEFAULTS.products);
      const idx = products.findIndex((p) => p.id === id);
      if (idx === -1) return notFound();
      products[idx] = { ...products[idx], ...body, ar: { ...products[idx].ar, ...(body.ar || {}) } };
      await putJSON(env, "products", products);
      return json(products[idx]);
    }
    if (path.startsWith("/api/admin/products/") && method === "DELETE") {
      const id = path.split("/").pop();
      let products = await getJSON(env, "products", DEFAULTS.products);
      products = products.filter((p) => p.id !== id);
      await putJSON(env, "products", products);
      return json({ ok: true });
    }

    // Categories CRUD
    if (path === "/api/admin/categories" && method === "GET") {
      return json(await getJSON(env, "categories", DEFAULTS.categories));
    }
    if (path === "/api/admin/categories" && method === "POST") {
      const body = await request.json();
      const categories = await getJSON(env, "categories", DEFAULTS.categories);
      const cat = {
        id: body.id || uid(),
        icon: body.icon || "🍽️",
        name_ar: body.name_ar || "",
        order: body.order ?? categories.length,
        active: body.active !== false,
      };
      categories.push(cat);
      await putJSON(env, "categories", categories);
      return json(cat, 201);
    }
    if (path.startsWith("/api/admin/categories/") && method === "PUT") {
      const id = path.split("/").pop();
      const body = await request.json();
      const categories = await getJSON(env, "categories", DEFAULTS.categories);
      const idx = categories.findIndex((c) => c.id === id);
      if (idx === -1) return notFound();
      categories[idx] = { ...categories[idx], ...body };
      await putJSON(env, "categories", categories);
      return json(categories[idx]);
    }
    if (path.startsWith("/api/admin/categories/") && method === "DELETE") {
      const id = path.split("/").pop();
      let categories = await getJSON(env, "categories", DEFAULTS.categories);
      categories = categories.filter((c) => c.id !== id);
      await putJSON(env, "categories", categories);
      return json({ ok: true });
    }

    // Settings
    if (path === "/api/admin/settings" && method === "GET") {
      return json(await getJSON(env, "settings", DEFAULTS.settings));
    }
    if (path === "/api/admin/settings" && method === "PUT") {
      const body = await request.json();
      const settings = await getJSON(env, "settings", DEFAULTS.settings);
      const updated = { ...settings, ...body };
      await putJSON(env, "settings", updated);
      return json(updated);
    }

    // Gallery
    if (path === "/api/admin/gallery" && method === "GET") {
      return json(await getJSON(env, "gallery", DEFAULTS.gallery));
    }
    if (path === "/api/admin/gallery" && method === "POST") {
      const body = await request.json();
      const gallery = await getJSON(env, "gallery", DEFAULTS.gallery);
      const item = { id: uid(), url: body.url, caption: body.caption || "" };
      gallery.push(item);
      await putJSON(env, "gallery", gallery);
      return json(item, 201);
    }
    if (path.startsWith("/api/admin/gallery/") && method === "DELETE") {
      const id = path.split("/").pop();
      let gallery = await getJSON(env, "gallery", DEFAULTS.gallery);
      gallery = gallery.filter((g) => g.id !== id);
      await putJSON(env, "gallery", gallery);
      return json({ ok: true });
    }

    // Analytics detail
    if (path === "/api/admin/analytics" && method === "GET") {
      return json(await getJSON(env, "analytics", DEFAULTS.analytics));
    }

    // One-time / re-seed import from the static site
    if (path === "/api/admin/seed" && method === "POST") {
      const body = await request.json();
      if (Array.isArray(body.products)) await putJSON(env, "products", body.products);
      if (Array.isArray(body.categories)) await putJSON(env, "categories", body.categories);
      if (body.settings) {
        const settings = await getJSON(env, "settings", DEFAULTS.settings);
        await putJSON(env, "settings", { ...settings, ...body.settings });
      }
      return json({ ok: true });
    }

    // Image upload (base64 -> R2)
    if (path === "/api/admin/upload" && method === "POST") {
      const body = await request.json();
      const folder = (body.folder || "misc").replace(/[^a-z0-9_-]/gi, "");
      const ext = (body.filename || "img.jpg").split(".").pop();
      const key = `${folder}/${uid()}.${ext}`;
      const binary = Uint8Array.from(atob(body.dataBase64), (c) => c.charCodeAt(0));
      await env.MENU_IMAGES.put(key, binary, {
        httpMetadata: { contentType: body.contentType || "image/jpeg" },
      });
      const publicUrl = `${url.origin}/images/${key}`;
      return json({ url: publicUrl, key }, 201);
    }

    return notFound();
  }

  return notFound();
}

async function handleImages(request, env, url) {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const key = url.pathname.replace(/^\/images\//, "");
  const obj = await env.MENU_IMAGES.get(key);
  if (!obj) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  headers.set("Content-Type", obj.httpMetadata?.contentType || "application/octet-stream");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(obj.body, { headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return new Response(null);

    try {
      // 1) طلبات الـ API
      if (path.startsWith("/api/")) {
        return await handleApi(request, env, url);
      }

      // 2) الصور المرفوعة من لوحة التحكم
      if (path.startsWith("/images/")) {
        return await handleImages(request, env, url);
      }

      // 3) كل شي غير هيك = ملفات ثابتة (الموقع، لوحة التحكم، إلخ)
      //    Cloudflare بيوصلها تلقائيًا من مجلد /site عن طريق env.ASSETS
      return env.ASSETS.fetch(request);
    } catch (err) {
      return json({ error: "server_error", message: String(err) }, 500);
    }
  },
};
