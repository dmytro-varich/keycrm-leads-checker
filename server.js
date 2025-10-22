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
        'http://localhost:8080',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:8080',
        'http://localhost:5500',
        'http://127.0.0.1:5500',
        'https://dmytro-varich.github.io'
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

// --- Кеш компаний в Map (для быстрого доступа по ID)
const companiesCache = new Map(); // Map<companyId, companyData>

// Функция для получения компании по ID (с кешем)
async function getCompanyById(companyId) {
    if (!companyId) return null;
    
    // Проверяем кеш
    if (companiesCache.has(companyId)) {
        console.log(`📦 Компания ${companyId} взята из кеша`);
        return companiesCache.get(companyId);
    }

    // Загружаем из API
    console.log(`🌐 Загрузка компании ${companyId} из KeyCRM`);
    try {
        const company = await keycrm(`/companies/${companyId}?include=custom_fields`);
        
        // Сохраняем в кеш
        companiesCache.set(companyId, company);
        
        return company;
    } catch (err) {
        console.error(`❌ Ошибка загрузки компании ${companyId}:`, err.message);
        return null;
    }
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

    // ID компании из buyer (НЕ загружаем данные компании здесь!)
    const companyId = (b && b.company_id) || null;

    // ключи для дедупликации (только телефоны и email из buyer)
    const dedupe = [
        ...phones.map((p) => `tel:${p}`),
        ...emails.map((e) => `email:${e}`),
    ];

    return {
        id,
        name,
        phones,
        emails,
        companyId, // возвращаем только ID, без данных компании
        dedupe
    };
}

// ================== ROUTES ==================

// Health check с проверкой ключа и кеша
app.get("/", (req, res) => {
    res.json({
        status: "ok",
        hasApiKey: !!KEYCRM_API_KEY,
        apiKeyLength: KEYCRM_API_KEY ? KEYCRM_API_KEY.length : 0,
        apiKeyPreview: KEYCRM_API_KEY ? `${KEYCRM_API_KEY.slice(0, 8)}...${KEYCRM_API_KEY.slice(-8)}` : null,
        cache: {
            companies_cached: companiesCache.size
        },
        timestamp: new Date().toISOString()
    });
});

// Очистить кеш компаний
app.post("/cache/clear", (req, res) => {
    const beforeCompanies = companiesCache.size;
    
    companiesCache.clear();
    
    console.log(`🗑️  Кеш очищен (компаний: ${beforeCompanies})`);
    
    res.json({ 
        message: "Кеш очищен",
        cleared: {
            companies: beforeCompanies
        }
    });
});

// Получить список всех компаний
// Пример: GET /companies?page=1&per_page=100
app.get("/companies", async(req, res) => {
    try {
        const page = req.query.page || 1;
        const per_page = req.query.per_page || 100;
        
        const qs = new URLSearchParams({
            page: String(page),
            per_page: String(per_page),
            include: 'custom_fields' // Важно! Получаем extrafields
        }).toString();
        
        const json = await keycrm(`/companies?${qs}`);
        
        res.json(json);
    } catch (err) {
        console.error("Ошибка при получении списка компаний:", err);
        res.status(500).json({ error: String(err.message || err) });
    }
});

// Получить все компании (с пагинацией)
// Пример: GET /companies/all?max=5000
app.get("/companies/all", async(req, res) => {
    try {
        const max = Number(req.query.max) || 5000;
        const perPage = 100;
        let page = 1;
        const acc = [];
        
        console.log(`📥 Начинаем сбор компаний (макс: ${max}, per_page: ${perPage})`);
        
        while (acc.length < max && page <= 100) {
            console.log(`   Запрос страницы ${page}...`);
            
            const qs = new URLSearchParams({
                page: String(page),
                per_page: String(perPage),
                include: 'custom_fields'
            }).toString();
            
            const json = await keycrm(`/companies?${qs}`);
            const raw = toArray(json);
            
            console.log(`   ✓ Страница ${page}: получено ${raw.length} компаний`);
            
            if (raw.length === 0) {
                console.log(`   ⚠ Страница ${page} пустая - останавливаем`);
                break;
            }
            
            // Сохраняем в кеш
            for (const company of raw) {
                if (company.id) {
                    companiesCache.set(company.id, company);
                }
            }
            
            acc.push(...raw);
            page++;
            
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        console.log(`📊 Собрано ${acc.length} компаний (в кеше: ${companiesCache.size})`);
        
        res.json({
            total: acc.length,
            cached: companiesCache.size,
            pages_processed: page - 1,
            data: acc.slice(0, max)
        });
    } catch (err) {
        console.error("❌ Ошибка при сборе компаний:", err);
        res.status(500).json({ error: String(err.message || err) });
    }
});

// Получить данные о компании по ID (с кешем)
// Пример: GET /companies/12345
app.get("/companies/:companyId", async(req, res) => {
    try {
        const { companyId } = req.params;

        if (!companyId) {
            return res.status(400).json({ error: "companyId обязателен" });
        }

        const company = await getCompanyById(companyId);
        
        if (!company) {
            return res.status(404).json({ error: "Компания не найдена" });
        }

        res.json(company);
    } catch (err) {
        console.error(`❌ Ошибка при получении компании ${req.params.companyId}:`, err);
        res.status(500).json({ error: String(err.message || err) });
    }
});

// RAW данные из KeyCRM — все поля без обработки
// Пример: GET /buyers/raw?page=1&per_page=5
app.get("/buyers/raw", async(req, res) => {
            try {
                const qs = new URLSearchParams(req.query).toString();
                const json = await keycrm(`/buyer${qs ? `?${qs}` : ""}`);
    // Возвращаем как есть из KeyCRM
    res.json(json);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

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
// Пример: GET /buyers/all?search=&max=5000
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

    console.log(`📊 Собрано ${acc.length} покупателей`);

    // Маппим покупателей БЕЗ данных компаний
    const data = acc.slice(0, max).map(buyer => mapBuyer(buyer));

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
    console.log(`→ GET  /                       (health check + статус кеша)`);
    console.log(`→ GET  /buyers                 (прокси KeyCRM GET /buyer)`);
    console.log(`→ GET  /buyers/raw             (RAW данные покупателей)`);
    console.log(`→ GET  /buyers/all             (все покупатели с пагинацией)`);
    console.log(`→ GET  /companies              (список компаний с пагинацией)`);
    console.log(`→ GET  /companies/all          (все компании + кеширование)`);
    console.log(`→ GET  /companies/:id          (получить компанию по ID с кешем)`);
    console.log(`→ POST /cache/clear            (очистить кеш компаний)`);
});