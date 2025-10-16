// server.js — простое API для получения списков покупателей из KeyCRM
// Требуется Node >= 18 (есть глобальный fetch).
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = "https://openapi.keycrm.app/v1";
const KEYCRM_API_KEY = process.env.KEYCRM_API_KEY;

// --- middleware
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'https://dmytro-varich.github.io/keycrm-leads-checker/'  // ← ваш домен GitHub Pages
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true,
  optionsSuccessStatus: 200
}));
app.use(express.json({ limit: "5mb" }));
app.use(morgan("dev"));

// --- утилиты
const ensureArray = (v) =>
    Array.isArray(v) ? v.filter(Boolean) : v ? [v] : [];

const toArray = (j) => {
    if (Array.isArray(j)) return j;
    if (j && j.data) return j.data;
    if (j && j.items) return j.items;
    return [];
};

const normalizeUaPhone = (phone) => {
    let s = String(phone || "").trim();
    if (!s) return "";
    s = s.replace(/[\s()-]/g, "");
    if (s.startsWith("00")) s = "+" + s.slice(2);
    if (s.startsWith("+380")) return s;
    if (/^380\d{9}$/.test(s)) return "+" + s;
    if (/^0\d{9}$/.test(s)) return "+38" + s; // 0XXXXXXXXX -> +380XXXXXXXXX
    if (s.startsWith("+")) return s; // другие страны — оставляем как есть
    return s;
};
const normalizeEmail = (email) =>
    String(email || "")
    .trim()
    .toLowerCase();

async function keycrm(path, { method = "GET", headers = {}, body } = {}) {
    if (!KEYCRM_API_KEY) throw new Error("KEYCRM_API_KEY не задан в .env");

    const res = await fetch(
        path.startsWith("http") ? path : `${BASE_URL}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${KEYCRM_API_KEY}`,
                "Content-Type": "application/json",
                ...headers,
            },
            body: body ? JSON.stringify(body) : undefined,
        }
    );

    const text = await res.text();
    const json = text ? JSON.parse(text) : null;

    if (!res.ok) {
        const msg =
            (json && json.message) || (json && json.error) || res.statusText;
        throw new Error(`KeyCRM ${method} ${path} -> ${res.status}: ${msg}`);
    }
    return json;
}

// --- Трансформер покупателя в «канон» для сверки
function mapBuyer(b) {
    // разные аккаунты могут хранить поля по-разному
    const id = (b && b.id) || (b && b.buyer_id) || null;
    const name =
        (b && b.name) ||
        (b && b.full_name) ||
        (b && b.fullname) ||
        (b && b.first_name && b.last_name ? `${b.first_name || ""} ${b.last_name || ""}`.trim() : "");

    const phones = ensureArray((b && b.phone) || (b && b.phones))
        .map(normalizeUaPhone)
        .filter(Boolean);
    const emails = ensureArray((b && b.email) || (b && b.emails))
        .map(normalizeEmail)
        .filter(Boolean);

    // ключи для дедупликации
    const dedupe = [
        ...phones.map((p) => `tel:${p}`),
        ...emails.map((e) => `email:${e}`),
    ];

    return { id, name, phones, emails, dedupe };
}

// ================== ROUTES ==================

// 1) Прозрачный прокси на GET /buyer (с пагинацией и поиском)
// Пример: GET /buyers?search=%2B380501234567&page=1&per_page=100
app.get("/buyers", async(req, res) => {
            try {
                const qs = new URLSearchParams(req.query).toString();
                const json = await keycrm(`/buyer${qs ? `?${qs}` : ""}`);
    const raw = toArray(json);
    const data = raw.map(mapBuyer);
    res.json({ count: data.length, data, raw }); // raw возвращаем на всякий для отладки
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// 2) Сбор «всех» покупателей (пагинация по страницам до лимита)
// Пример: GET /buyers/all?search=&per_page=100&max=5000
app.get("/buyers/all", async (req, res) => {
  try {
    const search = req.query.search || "";
    const perPage = 15; // KeyCRM отдаёт по 15 записей на страницу
    const max = Number(req.query.max) || 10000;
    let page = 1;

    const acc = [];
    console.log(`📥 Начинаем сбор покупателей (макс: ${max}, per_page: ${perPage})`);

    while (acc.length < max && page <= 1000) {
      console.log(`   Запрос страницы ${page}...`);

      const qs = new URLSearchParams({
        ...(search ? { search } : {}),
        page: String(page),
        per_page: String(perPage),
      }).toString();

      const json = await keycrm(`/buyer?${qs}`);
      const raw = toArray(json);
      
      console.log(`   ✓ Страница ${page}: получено ${raw.length} записей`);

      // Если страница пустая - останавливаемся
      if (raw.length === 0) {
        console.log(`   ⚠ Страница ${page} пустая - останавливаем`);
        break;
      }

      acc.push(...raw);
      page++;

      // Увеличена задержка чтобы избежать 429 Too Many Requests
      await new Promise(resolve => setTimeout(resolve, 800));
    }

    const data = acc.slice(0, max).map(mapBuyer);
    console.log(`✅ ИТОГО собрано покупателей: ${data.length} (запрошено: ${max}, страниц: ${page - 1})`);

    res.json({
      total: data.length,
      pages_processed: page - 1,
      per_page: perPage,
      search: search || null,
      data,
    });
  } catch (err) {
    console.error("❌ Ошибка при сборе покупателей:", err);
    res.status(500).json({ error: String(err.message || err) });
  }
});app.get("/test-keycrm", async(req, res) => {
    try {
        // Запрос первой страницы напрямую
        const page1 = await keycrm("/buyer?page=1&per_page=100");

        // Запрос второй страницы
        const page2 = await keycrm("/buyer?page=2&per_page=100");

        res.json({
            page1_count: toArray(page1).length,
            page1_meta: page1.meta || "нет meta",
            page2_count: toArray(page2).length,
            page2_meta: page2.meta || "нет meta",
            page1_sample: toArray(page1).slice(0, 2), // первые 2 записи
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/test-pages", async(req, res) => {
    try {
        const results = [];
        
        // Запросим первые 5 страниц
        for (let p = 1; p <= 5; p++) {
            const json = await keycrm(`/buyer?page=${p}&per_page=15`);
            const data = toArray(json);
            results.push({
                page: p,
                count: data.length,
                has_data: data.length > 0
            });
            
            if (data.length === 0) break;
        }
        
        res.json({
            pages_tested: results,
            total_unique_buyers: results.reduce((sum, r) => sum + r.count, 0)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ================== START ==================
app.listen(PORT, () => {
    console.log(`🚀 API запущен: http://localhost:${PORT}`);
    console.log(`→ GET /buyers        (прокси KeyCRM GET /buyer)`);
    console.log(`→ GET /buyers/all    (соберёт все страницы до лимита)`);
});