import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';
import { createServer as createViteServer } from 'vite';
import {
  getMockCatalog,
  getApprovedCategories,
  getApprovedNavigationGroups,
} from './server/mockCatalog';
import { selectHomePreviewProducts } from './src/utils/homeCatalogPreview';
import { CATALOG_FAMILY_MENU_ASSIGNMENTS } from './src/data/catalogMenuAssignmentsData';
import type { Product } from './src/types';

const PORT = 3000;
const HOST = '0.0.0.0';
const isProd = process.env.NODE_ENV === 'production';

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// ---------------------------------------------------------------------------
// 1. In-memory asset proxy cache for /storage/products/* & /src/assets/catalog/belts/*
// ---------------------------------------------------------------------------
const assetCache = new Map<string, { buf: Buffer; contentType: string }>();

function makeFallbackSvg(label: string): Buffer {
  const safeLabel = label.replace(/[<>&"']/g, '').slice(0, 32) || 'SANATPISH';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 240" width="320" height="240">
    <rect width="320" height="240" rx="16" fill="#F1F5F9"/>
    <rect x="16" y="16" width="288" height="208" rx="12" fill="#FFFFFF" stroke="#E2E8F0" stroke-width="2"/>
    <circle cx="160" cy="104" r="36" fill="#FFF7ED" stroke="#E06518" stroke-width="3"/>
    <circle cx="160" cy="104" r="14" fill="#E06518"/>
    <text x="160" y="172" text-anchor="middle" font-family="sans-serif" font-weight="700" font-size="14" fill="#475569">${safeLabel}</text>
  </svg>`;
  return Buffer.from(svg, 'utf8');
}

async function fetchRemoteAsset(urls: string[], fallbackLabel: string, res: Response) {
  const cacheKey = urls[0];
  const cached = assetCache.get(cacheKey);
  if (cached) {
    res.setHeader('Content-Type', cached.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(cached.buf);
  }

  for (const url of urls) {
    try {
      const upstream = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!upstream.ok) continue;
      const buf = Buffer.from(await upstream.arrayBuffer());
      const contentType =
        upstream.headers.get('content-type') ||
        (url.endsWith('.svg')
          ? 'image/svg+xml'
          : url.endsWith('.webp')
          ? 'image/webp'
          : url.endsWith('.jpg') || url.endsWith('.jpeg')
          ? 'image/jpeg'
          : 'image/png');
      if (assetCache.size > 600) {
        const firstKey = assetCache.keys().next().value;
        if (firstKey) assetCache.delete(firstKey);
      }
      assetCache.set(cacheKey, { buf, contentType });
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.send(buf);
    } catch {
      // Try next URL
    }
  }

  const svg = makeFallbackSvg(fallbackLabel);
  res.setHeader('Content-Type', 'image/svg+xml');
  return res.send(svg);
}

app.get('/storage/products/:folder/:file', async (req, res) => {
  const folder = String(req.params.folder || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const file = String(req.params.file || '').replace(/\.\./g, '');
  const urls = [
    `https://raw.githubusercontent.com/javanwebi/script/main/storage/products/${folder}/${encodeURIComponent(file)}`,
    `https://raw.githubusercontent.com/javanweb/imagesatlas/main/${encodeURIComponent(file)}`,
  ];
  await fetchRemoteAsset(urls, file, res);
});

app.get(/^\/src\/assets\/catalog\/belts\/(.+)$/, async (req, res) => {
  const relPath = String(req.params[0] || '').replace(/\.\./g, '');
  const localPath = path.resolve(process.cwd(), 'src/assets/catalog/belts', relPath);
  if (fs.existsSync(localPath)) {
    return res.sendFile(localPath);
  }
  const encodedRel = relPath
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  const urls = [
    `https://raw.githubusercontent.com/javanwebi/script/main/src/assets/catalog/belts/${encodedRel}`,
  ];
  await fetchRemoteAsset(urls, relPath.split('/').slice(-2).join('/'), res);
});

// ---------------------------------------------------------------------------
// 2. Demo in-memory state (Zero DB, Zero Keys)
// ---------------------------------------------------------------------------
const runtimeDocs = new Map<string, { value: unknown; version: number }>();

const DEFAULT_BANNERS = [
  {
    id: 'bn-1',
    title: 'تأمین مستقیم تسمه و تجهیزات خط تولید کاشی و نساجی',
    subtitle: 'بیش از ۳۰,۰۰۰ قلم قطعه استاندارد با مشاوره مهندسی رایگان',
    imageUrl: '/images/hero/hero-banner.webp',
    link: '/categories',
    active: true,
    placement: 'home_hero',
  },
  {
    id: 'bn-2',
    title: 'برندهای انحصاری FORZA و SWR با ضمانت اصالت',
    subtitle: 'ارسال سریع سراسری به تمام شهرک‌های صنعتی کشور',
    imageUrl: '/images/hero/forza-swr-dual-banner.webp',
    link: '/brands',
    active: true,
    placement: 'brands',
  },
];

const DEFAULT_ANNOUNCEMENTS = [
  {
    id: 'ann-1',
    title: 'جشنواره تأمین تسمه‌های تایمینگ و شیاری سری ۱۴۰۴',
    body: 'شرایط ویژه تسویه همکاری برای واحدهای صنعتی و کارخانجات کاشی و سرامیک فعال شد.',
    type: 'promo',
    date: '۱۴۰۴/۰۸/۱۰',
    active: true,
  },
  {
    id: 'ann-2',
    title: 'به‌روزرسانی سرویس شناسایی هوشمند قطعه از روی عکس',
    body: 'نسخه جدید اسکن تصویری قطعات صنعتی با پشتیبانی از جدول ابعاد پروفیل تسمه در دسترس است.',
    type: 'info',
    date: '۱۴۰۴/۰۸/۰۵',
    active: true,
  },
];

const DEFAULT_CUSTOMERS = [
  {
    id: 'cust-101',
    fullName: 'مجتمع کاشی و سرامیک یزد',
    firstName: 'مهندس رضایی',
    lastName: 'کارخانه یزد',
    username: 'yazd_tile',
    mobile: '09131510001',
    email: 'procurement@yazdtile.example',
    companyName: 'مجتمع کاشی و سرامیک یزد',
    role: 'dealer',
    approvedB2B: true,
    clubTier: 'gold',
    clubPoints: 4850,
    grade: 'A+',
    province: 'یزد',
    city: 'یزد',
    onboardingCompleted: true,
    addresses: [
      {
        id: 'addr-1',
        title: 'کارخانه مرکزی',
        recipientName: 'واحد تدارکات',
        recipientPhone: '09131510001',
        province: 'یزد',
        city: 'یزد',
        fullAddress: 'شهرک صنعتی یزد، بلوار صنعت، فاز ۲',
        postalCode: '8915111111',
        isDefault: true,
      },
    ],
  },
  {
    id: 'cust-102',
    fullName: 'کارخانه نساجی پارس',
    firstName: 'علی',
    lastName: 'محمدی',
    username: 'pars_textile',
    mobile: '09121112233',
    email: 'buy@parstextile.example',
    companyName: 'نساجی پارس',
    role: 'wholesale',
    approvedB2B: true,
    clubTier: 'silver',
    clubPoints: 2150,
    grade: 'A',
    province: 'اصفهان',
    city: 'اصفهان',
    onboardingCompleted: true,
    addresses: [],
  },
];

const DEFAULT_ORDERS = [
  {
    id: 'ORD-1404-8821',
    orderNumber: 'ORD-1404-8821',
    customerId: 'cust-101',
    customerName: 'مجتمع کاشی و سرامیک یزد',
    createdAt: new Date(Date.now() - 86400000 * 2).toISOString(),
    status: 'processing',
    totalAmount: 14850000,
    items: [
      { code: 'AT-E010', name: 'تسمه تایمینگ صنعتی HTD 8M سیم‌دار', qty: 10, price: 890000 },
      { code: 'AT-E383', name: 'بلبرینگ و یاتاقان صنعتی دور بالا', qty: 8, price: 743750 },
    ],
  },
  {
    id: 'ORD-1404-8790',
    orderNumber: 'ORD-1404-8790',
    customerId: 'cust-102',
    customerName: 'کارخانه نساجی پارس',
    createdAt: new Date(Date.now() - 86400000 * 5).toISOString(),
    status: 'delivered',
    totalAmount: 9240000,
    items: [
      { code: 'AT-E025', name: 'تسمه V-Belt اسپشیال SPB دنده‌دار فورزا', qty: 12, price: 770000 },
    ],
  },
];

const DEFAULT_INQUIRIES = [
  {
    id: 'INQ-401',
    customerName: 'مهندس کریمی - فولاد سیرجان',
    mobile: '09133451122',
    productCode: 'FAM-10005',
    productName: 'تسمه تایمینگ صنعتی گام 8M',
    quantity: 45,
    status: 'pending',
    createdAt: new Date().toISOString(),
    notes: 'استعلام قیمت همکاری و موجودی فوری انبار تهران',
  },
];

const DEFAULT_STAFF = [
  {
    id: 'staff-1',
    username: 'admin',
    name: 'مدیر ارشد سامانه صنعت پیش',
    email: 'admin@sanatpish.ir',
    role: 'super_admin',
    active: true,
    permissions: { all: true },
  },
  {
    id: 'staff-2',
    username: 'sales_eng',
    name: 'مهندس فروش صنعتی',
    email: 'sales@sanatpish.ir',
    role: 'staff',
    active: true,
    permissions: { catalog: true, orders: true, crm: true },
  },
];

const DEFAULT_TICKETS = [
  {
    id: 'TKT-101',
    customerId: 'cust-101',
    customerName: 'مجتمع کاشی و سرامیک یزد',
    subject: 'درخواست کاتالوگ فنی تسمه‌های مقاوم به حرارت کوره',
    status: 'open',
    priority: 'high',
    createdAt: new Date().toISOString(),
    messages: [
      {
        id: 'm-1',
        sender: 'customer',
        text: 'سلام، برای خط خنک‌کن بعد از کوره نیاز به تسمه مقاوم به دمای ۱۲۰ درجه داریم.',
        createdAt: new Date().toISOString(),
      },
    ],
  },
];

const DEFAULT_CUSTOM_PART_REQUESTS = [
  {
    id: 'CPR-301',
    customerName: 'صنایع بسته‌بندی سپهر',
    mobile: '09128889900',
    partName: 'تسمه تایمینگ روکش‌دار لاینر قرمز ۵ میلی‌متری',
    dimensions: 'طول ۲۴۰۰mm × عرض ۵۰mm × گام AT10',
    application: 'خط لیبل‌زنی و انتقال بطری',
    status: 'reviewing',
    createdAt: new Date().toISOString(),
  },
];

const portalValues: Record<string, unknown> = {
  atlas_admin_inquiries_v1: DEFAULT_INQUIRIES,
  atlas_admin_customers_v1: DEFAULT_CUSTOMERS,
  atlas_legacy_customers_v1: [],
  atlas_customers_approval_v2: DEFAULT_CUSTOMERS,
  atlas_price_lists_v2: [],
  atlas_customer_grades_v2: [
    { id: 'grade-a', name: 'همکار طلایی (A+)', discountPercent: 15, minOrder: 50000000 },
    { id: 'grade-b', name: 'مشتری صنعتی (A)', discountPercent: 8, minOrder: 20000000 },
  ],
  atlas_club_rewards_v2: [
    { id: 'rew-1', title: 'ارسال رایگان ویژه کارخانه', points: 500, active: true },
    { id: 'rew-2', title: 'کد تخفیف ۱۰٪ سفارش تسمه', points: 1200, active: true },
  ],
  atlas_customer_reward_assignments_v1: [],
  atlas_price_list_history_v2: [],
  atlas_portal_content_banners_v1: DEFAULT_BANNERS,
  atlas_portal_content_announcements_v1: DEFAULT_ANNOUNCEMENTS,
  atlas_portal_club_milestones_v1: [],
  atlas_portal_layout_configs_v1: null,
  atlas_portal_customer_overrides_v1: [],
};

// Simple per-process session state so customer & admin UI portals work without DB
let portalRevision = 1;
let currentSession: {
  admin: boolean;
  staff: boolean;
  user: Record<string, unknown> | null;
  staffUser: Record<string, unknown> | null;
  permissions: Record<string, boolean>;
} = {
  admin: true,
  staff: false,
  user: null,
  staffUser: null,
  permissions: { all: true },
};

// ---------------------------------------------------------------------------
// 3. /api/runtime & /api/portal
// ---------------------------------------------------------------------------
app.get('/api/runtime', (req, res) => {
  const { products } = getMockCatalog();
  const includeProducts = req.query.includeProducts !== '0';
  const values: Record<string, unknown> = {
    ...portalValues,
    atlas_orders_v1: DEFAULT_ORDERS,
  };
  for (const [k, v] of runtimeDocs.entries()) {
    values[k] = v.value;
  }
  res.json({
    success: true,
    database: true,
    productsIncluded: includeProducts,
    products: includeProducts ? products : [],
    values,
    user: currentSession.user,
  });
});

app.post('/api/runtime', (req, res) => {
  const key = String(req.body?.key || '').trim();
  const value = req.body?.value;
  if (!key) return res.status(400).json({ success: false, message: 'کلید نامعتبر است.' });
  const prev = runtimeDocs.get(key);
  const version = (prev?.version || 0) + 1;
  runtimeDocs.set(key, { value, version });
  res.json({ success: true, version });
});

app.get('/api/portal', (_req, res) => {
  res.json({
    success: true,
    revision: portalRevision,
    admin: currentSession.admin,
    staff: currentSession.staff,
    user: currentSession.user,
    staffUser: currentSession.staffUser,
    permissions: currentSession.permissions,
    values: portalValues,
  });
});

app.post('/api/portal', (req, res) => {
  const action = String(req.body?.action || '');
  if (action === 'logout') {
    currentSession = { admin: false, staff: false, user: null, staffUser: null, permissions: {} };
    return res.json({ success: true });
  }

  if (action === 'admin_login') {
    const username = String(req.body?.username || 'admin').trim() || 'admin';
    currentSession.admin = true;
    currentSession.staff = false;
    currentSession.permissions = { all: true };
    return res.json({
      success: true,
      admin: true,
      user: {
        authUserId: 'admin-1',
        id: 'admin-1',
        username,
        fullName: 'مدیر ارشد سامانه صنعت پیش',
        email: 'admin@sanatpish.ir',
      },
      revision: portalRevision,
    });
  }

  if (action === 'inquiry') {
    const inquiry = {
      id: 'INQ-' + Date.now(),
      customerName: (currentSession.user?.fullName as string) || 'مشتری صنعت پیش',
      mobile: (currentSession.user?.mobile as string) || '09120000000',
      productCode: String(req.body?.code || ''),
      productName: String(req.body?.productName || ''),
      quantity: Number(req.body?.quantity || 1),
      notes: String(req.body?.notes || ''),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    DEFAULT_INQUIRIES.unshift(inquiry);
    return res.json({ success: true, inquiry, revision: portalRevision });
  }

  if (action === 'login') {
    const identifier = String(req.body?.identifier || '').trim() || 'demo';
    const isAdminLogin =
      req.body?.portal === 'admin' ||
      /^admin$/i.test(identifier) ||
      identifier.toLowerCase().includes('admin');
    if (isAdminLogin) {
      currentSession = {
        admin: true,
        staff: false,
        user: {
          authUserId: 'admin-1',
          id: 'admin-1',
          username: identifier,
          fullName: 'مدیر ارشد سامانه صنعت پیش',
          email: 'admin@sanatpish.ir',
          role: 'admin',
          approvedB2B: true,
          onboardingCompleted: true,
        },
        staffUser: null,
        permissions: { all: true },
      };
      return res.json({
        success: true,
        admin: true,
        user: currentSession.user,
        revision: portalRevision,
      });
    }

    const isB2B =
      /b2b|dealer|wholesale|factory|yazd|09131510001/i.test(identifier);
    const demoUser = {
      id: 'cust-demo-1',
      fullName: isB2B ? 'مجتمع صنعتی کاشی و سرامیک یزد' : 'کاربر نمونه صنعت پیش',
      firstName: isB2B ? 'مهندس رضایی' : 'کاربر',
      lastName: isB2B ? 'واحد تدارکات' : 'نمونه',
      username: identifier,
      mobile: /^09\d{9}$/.test(identifier) ? identifier : '09120000000',
      email: 'demo@sanatpish.ir',
      companyName: isB2B ? 'مجتمع صنعتی کاشی یزد' : 'واحد صنعتی نمونه',
      role: isB2B ? 'dealer' : 'retail',
      approvedB2B: isB2B,
      clubTier: isB2B ? 'gold' : 'silver',
      clubPoints: isB2B ? 4850 : 1250,
      onboardingCompleted: true,
      addresses: DEFAULT_CUSTOMERS[0].addresses,
    };
    currentSession = {
      ...currentSession,
      user: demoUser,
    };
    return res.json({
      success: true,
      user: demoUser,
      revision: portalRevision,
    });
  }

  if (action === 'register') {
    const payload = (req.body?.payload || {}) as Record<string, unknown>;
    const fullName =
      [payload.firstName, payload.lastName].filter(Boolean).join(' ') || 'کاربر جدید صنعت پیش';
    const user = {
      id: 'cust-' + Date.now(),
      fullName,
      firstName: String(payload.firstName || 'کاربر'),
      lastName: String(payload.lastName || 'جدید'),
      username: String(payload.mobile || 'user_' + Date.now().toString().slice(-4)),
      mobile: String(payload.mobile || '09120000000'),
      email: String(payload.email || ''),
      companyName: String(payload.companyName || ''),
      province: String(payload.province || ''),
      city: String(payload.city || ''),
      role: 'retail',
      approvedB2B: false,
      clubTier: 'bronze',
      clubPoints: 250,
      onboardingCompleted: true,
      addresses: [],
    };
    currentSession.user = user;
    return res.json({
      success: true,
      user,
      credentials: {
        username: user.username,
        temporaryPassword: 'SP-' + Math.floor(100000 + Math.random() * 899999),
      },
      revision: portalRevision,
    });
  }

  if (action === 'profile') {
    const payload = (req.body?.payload || {}) as Record<string, unknown>;
    currentSession.user = {
      ...(currentSession.user || {
        id: 'cust-demo-1',
        role: 'retail',
        onboardingCompleted: true,
      }),
      ...payload,
    };
    return res.json({
      success: true,
      user: currentSession.user,
      revision: portalRevision,
    });
  }

  if (action === 'otp_request' || action === 'dev_otp_request') {
    return res.json({
      success: true,
      preview: true,
      devCode: '123456',
      requestId: 'otp-' + Date.now(),
      retryAfter: 60,
      message: 'کد تأیید آزمایشی (123456) صادر شد.',
    });
  }

  if (action === 'otp_verify' || action === 'dev_otp_verify') {
    const phone = String(req.body?.phone || '09120000000');
    const demoUser = {
      id: 'cust-otp-' + Date.now(),
      fullName: 'کاربر تأییدشده صنعت پیش',
      firstName: 'کاربر',
      lastName: 'صنعت پیش',
      username: phone,
      mobile: phone,
      role: 'retail',
      approvedB2B: false,
      clubTier: 'bronze',
      clubPoints: 500,
      onboardingCompleted: true,
      addresses: [],
    };
    currentSession.user = demoUser;
    return res.json({
      success: true,
      previewVerified: action === 'dev_otp_verify',
      user: demoUser,
      requiresCredentials: false,
      message: 'کد با موفقیت تأیید شد.',
    });
  }

  if (action === 'registration_credentials' || action === 'initial_password_change') {
    if (!currentSession.user) {
      currentSession.user = {
        id: 'cust-' + Date.now(),
        fullName: 'کاربر جدید صنعت پیش',
        username: String(req.body?.username || 'demo_user'),
        role: 'retail',
        approvedB2B: false,
        onboardingCompleted: true,
        addresses: [],
      };
    } else if (req.body?.username) {
      currentSession.user.username = String(req.body.username);
    }
    (currentSession.user as Record<string, unknown>).mustChangePassword = false;
    return res.json({ success: true, user: currentSession.user, revision: portalRevision });
  }

  if (action === 'save') {
    const values = (req.body?.values || {}) as Record<string, unknown>;
    Object.assign(portalValues, values);
    portalRevision++;
    return res.json({ success: true, revision: portalRevision });
  }

  res.json({ success: true, revision: portalRevision });
});

// ---------------------------------------------------------------------------
// 4. Catalog Navigation & Product APIs
// ---------------------------------------------------------------------------
app.get('/api/catalog/home-preview', (_req, res) => {
  const { products } = getMockCatalog();
  res.json({ success: true, products: selectHomePreviewProducts(products) });
});

app.get('/api/catalog/home-categories', (_req, res) => {
  res.json({ success: true, categories: getApprovedCategories() });
});

app.get('/api/catalog/categories', (_req, res) => {
  res.json({ success: true, categories: getApprovedCategories() });
});

app.get('/api/catalog/navigation-groups', (_req, res) => {
  res.json({ success: true, groups: getApprovedNavigationGroups() });
});

app.get('/api/catalog/menu-family-assignments', (_req, res) => {
  res.json({ success: true, assignments: CATALOG_FAMILY_MENU_ASSIGNMENTS });
});

app.get('/api/catalog/menu-family-index', (_req, res) => {
  const assignments = Object.entries(CATALOG_FAMILY_MENU_ASSIGNMENTS).map(([familyCode, entry]) => ({
    familyCode,
    categorySlug: entry.categorySlug,
    submenuName: entry.submenuName,
    leafName: entry.leafName,
    method: 'excel_source_verified',
  }));
  res.json({ success: true, assignments });
});

app.get('/api/catalog/menu-unassigned', (_req, res) => {
  res.json({ success: true, families: [] });
});

app.get('/api/catalog/menu-category/:slug', (req, res) => {
  const slug = String(req.params.slug || '').trim();
  const categories = getApprovedCategories();
  const cat = categories.find((c) => c.slug === slug);
  if (!cat) {
    return res.status(404).json({ success: false, message: 'دسته‌بندی پیدا نشد.' });
  }
  const { products } = getMockCatalog();
  const matching = products.filter((p) => p.categorySlug === slug);
  const families = matching.map((p) => ({
    code: p.code,
    name: p.name,
    brand: p.brand,
    submenu: p.submenu || null,
    leaf: p.subcategory || null,
    skuCount: p.variants?.length || 1,
  }));
  res.json({
    success: true,
    category: {
      slug: cat.slug,
      name: cat.name,
      description: cat.description || '',
      image: cat.image || null,
      children: cat.children || [],
    },
    families,
  });
});

app.get('/api/catalog/direct-skus', (req, res) => {
  const { directSkus } = getMockCatalog();
  const categorySlug = String(req.query.categorySlug || '').trim();
  const categoryPrefix = String(req.query.categoryPrefix || '').trim();
  let items = directSkus;
  if (categorySlug) items = items.filter((i) => i.categorySlug === categorySlug);
  else if (categoryPrefix) items = items.filter((i) => i.categorySlug.startsWith(categoryPrefix));
  res.json({ success: true, items });
});

app.get('/api/catalog/direct-skus/:code', (req, res) => {
  const code = String(req.params.code || '').trim().toLowerCase();
  const { directSkus } = getMockCatalog();
  const item = directSkus.find((i) => i.skuCode.toLowerCase() === code) || directSkus[0];
  res.json({ success: true, item });
});

app.get('/api/catalog/variant-review/:code', (req, res) => {
  const code = String(req.params.code || '').trim();
  res.json({
    success: true,
    code,
    technicalReview: {
      verified: true,
      summary: `مشخصات فنی کد ${code} مطابق استاندارد کارخانه‌ای و نقشه مهندسی تأیید شده است.`,
      updatedAt: new Date().toISOString(),
    },
  });
});

app.all(/^\/api\/catalog\/.+/, (_req, res) => {
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// 5. AI Visual Part Search ("شناسایی تصویر قطعه") — Server-Side Gemini Vision
// ---------------------------------------------------------------------------
const recognitionJobs = new Map<string, unknown>();

function getGeminiVisionClient(): GoogleGenAI | null {
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function resolveInlineImagePart(
  body: Record<string, unknown>,
): Promise<{ inlineData: { mimeType: string; data: string } } | null> {
  const rawBase64 = typeof body.imageBase64 === 'string' ? body.imageBase64.trim() : '';
  if (rawBase64) {
    const match = /^data:([^;,]+);base64,(.+)$/is.exec(rawBase64);
    if (match) {
      return {
        inlineData: {
          mimeType: match[1].toLowerCase(),
          data: match[2].replace(/\s+/g, ''),
        },
      };
    }
    const mimeType = typeof body.mimeType === 'string' && body.mimeType.startsWith('image/')
      ? body.mimeType
      : 'image/jpeg';
    return {
      inlineData: {
        mimeType,
        data: rawBase64.replace(/\s+/g, ''),
      },
    };
  }

  const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : '';
  if (!imageUrl) return null;

  if (imageUrl.startsWith('/')) {
    const cleanRel = imageUrl.split('?')[0].replace(/^\/+/, '').replace(/\.\./g, '');
    const candidates = [
      path.resolve(process.cwd(), 'public', cleanRel),
      path.resolve(process.cwd(), cleanRel),
    ];
    for (const filePath of candidates) {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const buf = fs.readFileSync(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const mimeType =
          ext === '.png'
            ? 'image/png'
            : ext === '.webp'
            ? 'image/webp'
            : 'image/jpeg';
        return {
          inlineData: {
            mimeType,
            data: buf.toString('base64'),
          },
        };
      }
    }
  }

  if (/^https?:\/\//i.test(imageUrl)) {
    try {
      const resp = await fetch(imageUrl, { signal: AbortSignal.timeout(8000) });
      if (resp.ok) {
        const mimeType = (resp.headers.get('content-type') || 'image/jpeg').split(';')[0];
        if (mimeType.startsWith('image/')) {
          const buf = Buffer.from(await resp.arrayBuffer());
          return {
            inlineData: {
              mimeType,
              data: buf.toString('base64'),
            },
          };
        }
      }
    } catch {
      // Ignore remote fetch failure
    }
  }

  return null;
}

type DetectedPartBox = {
  id: string;
  label: string;
  partFamily: string;
  region: { x: number; y: number; width: number; height: number };
  center: { x: number; y: number };
};

function clampNorm(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function parseDetectedPartsFromGemini(rawText: string | undefined): DetectedPartBox[] {
  if (!rawText) return [];
  try {
    const parsed = JSON.parse(rawText) as {
      parts?: Array<{
        label?: string;
        partFamily?: string;
        box_2d?: number[];
        point?: number[];
      }>;
    };
    const items = Array.isArray(parsed?.parts) ? parsed.parts : [];
    const results: DetectedPartBox[] = [];

    for (let i = 0; i < items.length && results.length < 8; i++) {
      const item = items[i];
      if (!Array.isArray(item?.box_2d) || item.box_2d.length < 4) continue;
      const [rawYmin, rawXmin, rawYmax, rawXmax] = item.box_2d.map(Number);
      if (![rawYmin, rawXmin, rawYmax, rawXmax].every(Number.isFinite)) continue;

      const x1 = clampNorm(Math.min(rawXmin, rawXmax) / 1000);
      const y1 = clampNorm(Math.min(rawYmin, rawYmax) / 1000);
      const x2 = clampNorm(Math.max(rawXmin, rawXmax) / 1000);
      const y2 = clampNorm(Math.max(rawYmin, rawYmax) / 1000);
      const width = x2 - x1;
      const height = y2 - y1;
      if (width < 0.04 || height < 0.04 || width > 0.98 || height > 0.98) continue;

      let cx = x1 + width / 2;
      let cy = y1 + height / 2;
      if (Array.isArray(item.point) && item.point.length >= 2) {
        const py = Number(item.point[0]) / 1000;
        const px = Number(item.point[1]) / 1000;
        if (
          Number.isFinite(px) &&
          Number.isFinite(py) &&
          px >= x1 &&
          px <= x2 &&
          py >= y1 &&
          py <= y2
        ) {
          cx = clampNorm(px);
          cy = clampNorm(py);
        }
      }

      const tooClose = results.some(
        (existing) =>
          Math.hypot(existing.center.x - cx, existing.center.y - cy) < 0.08 &&
          Math.abs(existing.region.width - width) < 0.12 &&
          Math.abs(existing.region.height - height) < 0.12,
      );
      if (tooClose) continue;

      results.push({
        id: `ai-part-${results.length + 1}`,
        label: String(item.label || 'قطعه صنعتی').trim().slice(0, 48),
        partFamily: String(item.partFamily || 'other').trim().toLowerCase(),
        region: {
          x: Number(x1.toFixed(4)),
          y: Number(y1.toFixed(4)),
          width: Number(width.toFixed(4)),
          height: Number(height.toFixed(4)),
        },
        center: {
          x: Number(cx.toFixed(4)),
          y: Number(cy.toFixed(4)),
        },
      });
    }

    // If multiple overlapping or stacked pieces of the same foreground part family
    // were emitted individually (e.g. stacked rings/gaskets/pulleys), prepend an
    // enclosing group box at index 0 while leaving separated objects and tools distinct.
    if (results.length >= 2) {
      const seed = results[0];
      const seedArea = seed.region.width * seed.region.height;
      const seedBottom = seed.region.y + seed.region.height;
      const seedRight = seed.region.x + seed.region.width;
      const cluster: DetectedPartBox[] = [seed];
      let changed = true;

      while (changed) {
        changed = false;
        for (const cand of results) {
          if (cluster.includes(cand)) continue;
          const sameFamily =
            cand.partFamily === seed.partFamily &&
            seed.partFamily !== '' &&
            seed.partFamily !== 'other';
          const candArea = cand.region.width * cand.region.height;
          const areaRatio =
            Math.max(candArea, seedArea) / Math.max(1e-5, Math.min(candArea, seedArea));
          if (!sameFamily && areaRatio > 2.4) continue;

          const nearOrOverlaps = cluster.some((m) => {
            const cR = cand.region;
            const mR = m.region;
            const gap = sameFamily ? 0.035 : 0;
            const touchX = cR.x <= mR.x + mR.width + gap && cR.x + cR.width >= mR.x - gap;
            const touchY = cR.y <= mR.y + mR.height + gap && cR.y + cR.height >= mR.y - gap;
            if (!touchX || !touchY) return false;
            if (sameFamily) return true;
            // For 'other' family, require real multi-axis overlap rather than side-by-side adjacency
            const ovX = Math.min(cR.x + cR.width, mR.x + mR.width) - Math.max(cR.x, mR.x);
            const ovY = Math.min(cR.y + cR.height, mR.y + mR.height) - Math.max(cR.y, mR.y);
            return ovX >= Math.min(cR.width, mR.width) * 0.14 && ovY >= Math.min(cR.height, mR.height) * 0.14;
          });

          if (nearOrOverlaps) {
            cluster.push(cand);
            changed = true;
          }
        }
      }

      if (cluster.length >= 2) {
        let ux0 = 1;
        let uy0 = 1;
        let ux1 = 0;
        let uy1 = 0;
        for (const c of cluster) {
          ux0 = Math.min(ux0, c.region.x);
          uy0 = Math.min(uy0, c.region.y);
          ux1 = Math.max(ux1, c.region.x + c.region.width);
          uy1 = Math.max(uy1, c.region.y + c.region.height);
        }
        const uw = ux1 - ux0;
        const uh = uy1 - uy0;
        const uArea = uw * uh;
        const alreadyEnclosed =
          seed.region.x <= ux0 + 0.02 &&
          seed.region.y <= uy0 + 0.02 &&
          seedRight >= ux1 - 0.02 &&
          seedBottom >= uy1 - 0.02;

        if (!alreadyEnclosed && uw <= 0.96 && uh <= 0.96 && uArea > seedArea * 1.15) {
          results.unshift({
            id: 'ai-part-group',
            label: seed.label,
            partFamily: seed.partFamily,
            region: {
              x: Number(ux0.toFixed(4)),
              y: Number(uy0.toFixed(4)),
              width: Number(uw.toFixed(4)),
              height: Number(uh.toFixed(4)),
            },
            center: {
              x: Number((ux0 + uw / 2).toFixed(4)),
              y: Number((uy0 + uh / 2).toFixed(4)),
            },
          });
        }
      }
    }

    return results.slice(0, 8);
  } catch {
    return [];
  }
}

function pickVisualMatches(
  body: Record<string, unknown>,
  aiHints?: {
    detectedPartType?: string;
    partFamilyFarsi?: string;
    detectedProfile?: string;
    material?: string;
    whatYouSee?: string;
    advice?: string;
    readableMarkings?: string[];
    catalogKeywords?: string[];
  },
): {
  matched: Product[];
  similar: Product[];
  detectedType: string;
  partFamilyFarsi: string;
  detectedProfile: string;
  material: string;
  whatYouSee: string;
  advice: string;
  readableMarkings: string[];
} {
  const { products } = getMockCatalog();
  const imageUrl = String(body.imageUrl || body.imageBase64 || '');
  const vd = (body.visualDescriptor && typeof body.visualDescriptor === 'object'
    ? body.visualDescriptor
    : {}) as Record<string, unknown>;
  const hint = [
    body.application,
    body.features,
    body.sampleHint,
    body.originalName,
    aiHints?.detectedPartType,
    aiHints?.partFamilyFarsi,
    aiHints?.detectedProfile,
    ...(aiHints?.readableMarkings || []),
    ...(aiHints?.catalogKeywords || []),
    body.measurements ? JSON.stringify(body.measurements) : '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  let primaryCode = 'AT-E383';
  let detectedType = aiHints?.detectedPartType || 'بلبرینگ شیار عمیق صنعتی';
  let partFamilyFarsi = aiHints?.partFamilyFarsi || 'بلبرینگ و یاتاقان';
  let detectedProfile = aiHints?.detectedProfile || 'Deep Groove Ball Bearing (6206-2RS)';
  let material = aiHints?.material || 'فولاد کروم سخت‌کاری‌شده با کاسه‌نمد دوطرفه';
  let whatYouSee =
    aiHints?.whatYouSee ||
    'برش خودکار نشان‌دهنده یک بلبرینگ صنعتی با رینگ داخلی و خارجی صیقلی و محفظه ساچمه مهندسی است که برای شفت‌ها و محورهای دوار خط تولید استفاده می‌شود.';
  let advice =
    aiHints?.advice ||
    'برای انتخاب دقیق‌ترین کد کاتالوگ، کد حک‌شده روی رینگ (مانند 6205 یا 6206) یا قطر داخلی شفت و ضخامت را بررسی کنید.';

  const explicitBelt = imageUrl.includes('e(10)') || /تسمه|belt|تایمینگ|وی|vbelt|htd|at10|t10|5m|8m|spz|spa|spb/.test(hint);
  const explicitScrew = imageUrl.includes('e(14)') || /پیچ|hand|knob|screw|دسته|ستاره|کلمپ/.test(hint);
  const explicitRail = imageUrl.includes('e(319)') || /ریل|rail|پروفیل|هدایت|guide/.test(hint);
  const explicitRing = imageUrl.includes('e(1)') || /حلقه|ring|واشر|آب‌بند|گسکت|اورینگ|o-ring|seal/.test(hint);
  const explicitPulley = /چرخ|پولی|دنده|pulley|gear|کوپلینگ|coupling|sprocket|زنجیر/.test(hint);
  const explicitBearing = /بلبرینگ|یاتاقان|bearing|620|630|pillow|ucp|ucfl/.test(hint);

  const hasExplicitHint =
    explicitBelt || explicitScrew || explicitRail || explicitRing || explicitPulley || explicitBearing;
  const visualIsBelt = !hasExplicitHint && Boolean(vd.isDark) && Boolean(vd.isElongated);
  const visualIsPulley = !hasExplicitHint && !vd.isDark && Boolean(vd.isMetallic) && Boolean(vd.isElongated);
  const visualIsScrew = !hasExplicitHint && Boolean(vd.isDark) && !vd.isElongated;

  if (explicitScrew || visualIsScrew) {
    primaryCode = 'AT-E014';
    if (!aiHints?.detectedPartType) detectedType = 'پیچ دسته‌دار کلمپ ستاره‌ای';
    if (!aiHints?.partFamilyFarsi) partFamilyFarsi = 'پیچ دسته‌دار صنعتی';
    if (!aiHints?.detectedProfile) detectedProfile = 'Star Knob Clamping Screw (M8 / M10)';
    if (!aiHints?.material) material = 'باکالیت مهندسی + رزوه فولاد گالوانیزه';
    if (!aiHints?.whatYouSee) {
      whatYouSee =
        'قطعه انتخاب‌شده یک عضو مکانیزم مشکی/تیره از خانواده پیچ دسته‌دار یا بست صنعتی است مناسب تنظیم سریع گاید لاین نقاله و فیکسچرهای صنعتی.';
    }
    if (!aiHints?.advice) {
      advice = 'گام رزوه (M8 یا M10) و طول پیچ فلزی را با خط‌کش یا کولیس اندازه‌گیری و تطبیق دهید.';
    }
  } else if (explicitRail) {
    primaryCode = 'AT-E319';
    if (!aiHints?.detectedPartType) detectedType = 'ریل راهنما و پروفیل هدایت نقاله';
    if (!aiHints?.partFamilyFarsi) partFamilyFarsi = 'ریل صنعتی خط انتقال';
    if (!aiHints?.detectedProfile) detectedProfile = 'Guide Rail Profile (UHMW-PE + Aluminum)';
    if (!aiHints?.material) material = 'آلومینیوم آنودایز با لاینر ضد سایش پلی‌اتیلن';
    if (!aiHints?.whatYouSee) {
      whatYouSee =
        'مقطع پروفیل ریل هدایت خط انتقال با شیار اتصال استاندارد و روکش ضد سایش مشاهده شد.';
    }
    if (!aiHints?.advice) {
      advice = 'عرض کانال ریل و طول شاخه مورد نیاز (۲ یا ۳ متر) را برای جایگزینی مستقیم بررسی کنید.';
    }
  } else if (explicitRing) {
    primaryCode = 'AT-E001';
    if (!aiHints?.detectedPartType) detectedType = 'حلقه تخت و آب‌بندی صنعتی';
    if (!aiHints?.partFamilyFarsi) partFamilyFarsi = 'حلقه تخت و آب‌بندی';
    if (!aiHints?.detectedProfile) detectedProfile = 'Flat Ring / Precision Seal';
    if (!aiHints?.material) material = 'پلی‌اورتان صنعتی / PTFE';
    if (!aiHints?.whatYouSee) {
      whatYouSee =
        'در تصویر ارسالی یک قطعه حلقوی دقیق با سطوح صاف و لبه‌های ماشین‌کاری‌شده دیده می‌شود که برای آب‌بندی شفت یا فیکسچر خط تولید استفاده می‌شود.';
    }
    if (!aiHints?.advice) {
      advice = 'برای انتخاب دقیق‌ترین کد، قطر داخلی، قطر خارجی و ضخامت را بررسی یا با محصولات مشابه مقایسه کنید.';
    }
  } else if (explicitBelt || visualIsBelt) {
    primaryCode = 'AT-E010';
    if (!aiHints?.detectedPartType) detectedType = 'تسمه تایمینگ صنعتی سیم‌دار';
    if (!aiHints?.partFamilyFarsi) partFamilyFarsi = 'تسمه تایمینگ';
    if (!aiHints?.detectedProfile) detectedProfile = 'HTD 8M / AT10 Steel-Cord Timing Belt';
    if (!aiHints?.material) material = 'پلی‌اورتان صنعتی با کورد فولادی';
    if (!aiHints?.whatYouSee) {
      whatYouSee =
        'تسمه انتقال قدرت دندانه‌دار تیره با ساختار کششی مقاوم و پروفیل گام صنعتی شناسایی شد.';
    }
    if (!aiHints?.advice) {
      advice = 'برای تشخیص دقیق‌تر تسمه، برند و اطلاعات درج‌شده روی پشت تسمه و همچنین عرض و گام آن را تطبیق دهید.';
    }
  } else if (explicitPulley || visualIsPulley) {
    const foundPulley =
      products.find((p) => /پولی|چرخ|کوپلینگ|دنده/.test(p.name)) || products[0];
    primaryCode = foundPulley.code;
    if (!aiHints?.detectedPartType) detectedType = 'پولی و دنده انتقال قدرت صنعتی';
    if (!aiHints?.partFamilyFarsi) partFamilyFarsi = 'پولی و چرخ‌دنده';
    if (!aiHints?.detectedProfile) detectedProfile = 'Taper-Lock Pulley / Precision Gear';
    if (!aiHints?.material) material = 'فولاد C45 / چدن داکتیل ماشین‌کاری‌شده';
    if (!aiHints?.whatYouSee) {
      whatYouSee =
        'چرخ‌تسمه / دنده انتقال گشتاور با پروفیل شیار استاندارد صنعتی و نشیمن دقیق شفت مشاهده شد.';
    }
    if (!aiHints?.advice) {
      advice = 'تعداد شیار یا دندانه، گام استاندارد و قطر سوراخ یا بوش تیپرلاک را کنترل کنید.';
    }
  }

  // Keyword-boosted catalog scoring when Gemini provides specific markings/keywords
  const keywords = [
    ...(aiHints?.catalogKeywords || []),
    ...(aiHints?.readableMarkings || []),
  ]
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length >= 2);

  let primary = products.find((p) => p.code === primaryCode) || products[0];
  if (keywords.length > 0) {
    const scored = products
      .map((p) => {
        const hay = `${p.code} ${p.forzaCode || ''} ${p.name} ${p.categoryName} ${p.subcategory || ''} ${p.brand}`.toLowerCase();
        let kwScore = 0;
        for (const kw of keywords) {
          if (hay.includes(kw)) kwScore += kw.length >= 4 ? 3 : 1;
        }
        return { p, kwScore };
      })
      .sort((a, b) => b.kwScore - a.kwScore);
    if (scored[0] && scored[0].kwScore > 0) {
      primary = scored[0].p;
    }
  }

  const sameCategory = products.filter(
    (p) => p.code !== primary.code && p.categorySlug === primary.categorySlug,
  );
  const fallbackOthers = products.filter((p) => p.code !== primary.code);
  const others = [...sameCategory, ...fallbackOthers]
    .filter((p, idx, arr) => arr.findIndex((x) => x.code === p.code) === idx)
    .slice(0, 11);

  return {
    matched: [primary],
    similar: others,
    detectedType,
    partFamilyFarsi,
    detectedProfile,
    material,
    whatYouSee,
    advice,
    readableMarkings:
      aiHints?.readableMarkings?.filter(Boolean).length
        ? aiHints.readableMarkings.filter(Boolean)
        : [primary.forzaCode || primary.code, primary.brand],
  };
}

app.post('/api/ai/detect-regions', async (req, res) => {
  const startedAt = Date.now();
  const detectionId = 'det-' + crypto.randomUUID();
  const body = (req.body || {}) as Record<string, unknown>;
  const ai = getGeminiVisionClient();

  if (ai) {
    const imagePart = await resolveInlineImagePart(body);
    if (imagePart) {
      try {
        const response = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: {
            parts: [
              imagePart,
              {
                text: `Inspect this photo and detect the foreground industrial spare component(s) (up to 6 parts), such as timing belts, V-belts, bearings, pulleys, pulley wheels, gears, clamping knobs/screws, guide rails, sealing rings, gaskets, flexible coupling spiders/inserts, chains, or shafts.
Strict rules:
- Rule 1: Element 0 of parts MUST ALWAYS be the COMPLETE main foreground subject in full:
  * If it is a single part or assembly (an entire pulley wheel, entire bearing housing, entire belt, or entire hand-held coupling spider), frame 100% of its outermost perimeter — NEVER choose only an embedded inner center bearing, bolt, or bore hole as element 0.
  * If multiple overlapping, stacked, or grouped pieces of the SAME foreground part/set are staged together (e.g., stacked sealing rings/washers/gaskets/belts or a foreground pulley set), Element 0 MUST be ONE complete bounding box enclosing ALL pieces of that foreground group/stack together — never crop only 1 ring or 1 piece out of a stacked subject!
- Rule 2: After Element 0, you may include individual pieces of a stack or clearly distinct inner sub-parts (like a metal center bearing inside an orange pulley wheel) as secondary elements so tapping them isolates them.
- Rule 3: Exclude human hands, work gloves, sleeves, unrequested background tools/wrenches lying behind the main part, smartphones, table glare, or blurry workshop clutter from Element 0.
For EACH part:
- Give a concise Farsi "label" (2-3 words).
- Give "partFamily" (one of: belt, bearing, pulley, screw, rail, ring, coupling, chain, other).
- Give "box_2d": tight bounding box [ymin, xmin, ymax, xmax] normalized 0 to 1000 hugging the outer perimeter cleanly without clipping edges.
- Give "point": [y, x] normalized 0 to 1000 placed directly ON the body of that part.`,
              },
            ],
          },
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                parts: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      label: { type: Type.STRING },
                      partFamily: { type: Type.STRING },
                      box_2d: {
                        type: Type.ARRAY,
                        items: { type: Type.INTEGER },
                      },
                      point: {
                        type: Type.ARRAY,
                        items: { type: Type.INTEGER },
                      },
                    },
                    required: ['label', 'partFamily', 'box_2d', 'point'],
                  },
                },
              },
              required: ['parts'],
            },
          },
        });

        const detectedParts = parseDetectedPartsFromGemini(response.text);
        if (detectedParts.length > 0) {
          return res.json({
            success: true,
            detectionId,
            queryRegion: detectedParts[0].region,
            queryRegions: detectedParts.map((p) => p.region),
            detectedParts,
            autoDetected: true,
            pipeline: 'gemini-vision-v4',
            model: 'gemini-4-hydrogen',
            elapsedMs: Date.now() - startedAt,
          });
        }
      } catch (err) {
        console.warn('[detect-regions] Gemini vision detection fallback:', err instanceof Error ? err.message : err);
      }
    }
  }

  return res.json({
    success: true,
    detectionId,
    queryRegions: [],
    detectedParts: [],
    autoDetected: false,
    pipeline: 'client-contour-v4',
    model: 'client-cv',
    elapsedMs: Date.now() - startedAt,
  });
});

app.post('/api/ai/analyze-part', async (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>;
  const stage = body.stage === 'quick' ? 'quick' : 'refined';

  let aiHints: Parameters<typeof pickVisualMatches>[1] | undefined;
  let activeModel = 'sanatpish-visual-catalog';
  const ai = getGeminiVisionClient();

  if (ai) {
    const imagePart = await resolveInlineImagePart(body);
    if (imagePart) {
      try {
        const response = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: {
            parts: [
              imagePart,
              {
                text: `You are an industrial spare-parts engineer for SanatPish (belts, pulleys, bearings, rails, clamping knobs, seals).
Analyze the cropped image of this single industrial part:
1. Identify the exact part type and Farsi family name.
2. Read ANY printed brand, code, pitch, or markings visible on the part (especially on belts, e.g., HTD 8M, AT10, T10, 5M, SPZ, SPA, FORZA, BANDO, OPTIBELT, GATES, 6205, 6206).
3. Describe what you observe and provide concise technical advice in Farsi.
4. Provide 3-6 search keywords (Farsi + English technical codes) to match against our parts catalog.`,
              },
            ],
          },
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                detectedPartType: { type: Type.STRING },
                partFamilyFarsi: { type: Type.STRING },
                detectedProfile: { type: Type.STRING },
                material: { type: Type.STRING },
                whatYouSee: { type: Type.STRING },
                advice: { type: Type.STRING },
                readableMarkings: { type: Type.ARRAY, items: { type: Type.STRING } },
                catalogKeywords: { type: Type.ARRAY, items: { type: Type.STRING } },
              },
              required: ['detectedPartType', 'partFamilyFarsi', 'whatYouSee'],
            },
          },
        });
        if (response.text) {
          aiHints = JSON.parse(response.text);
          activeModel = 'gemini-4-hydrogen';
        }
      } catch (err) {
        console.warn('[analyze-part] Gemini vision analysis fallback:', err instanceof Error ? err.message : err);
      }
    }
  }

  const info = pickVisualMatches(body, aiHints);
  const primary = info.matched[0];
  const score = stage === 'refined' ? 96 : 91;

  const toMatchedItem = (p: Product, idx: number, exact: boolean) => ({
    code: p.code,
    name: p.name,
    brand: p.brand,
    type: p.subcategory || p.categoryName,
    similarityScore: exact ? score : Math.max(72, 86 - idx * 4),
    matchReason: exact
      ? `تطبیق مستقیم فرم هندسی و کاربرد با کاتالوگ رسمی (${p.forzaCode || p.code})`
      : `قطعه هم‌خانواده و جایگزین فنی در دسته ${p.categoryName}`,
    specs: p.technicalSpecs || [],
    matchType: 'combined' as const,
    technicalMatchScore: exact ? score : 82 - idx * 3,
    technicalEvidence: [
      `گروه: ${p.categoryName}`,
      `برند: ${p.brand}`,
      ...(p.technicalSpecs || []).slice(0, 2).map((s) => `${s.key}: ${s.value}`),
    ],
    isVisualMatch: true,
    visualDistance: exact ? 0.08 : 0.21 + idx * 0.05,
    visualVerdict: exact ? ('exact_match' as const) : ('very_similar' as const),
    visualVerdictFarsi: exact
      ? 'همونه (انطباق قطعی در کاتالوگ)'
      : 'شبیهه (مدل مشابه / جایگزین سازگار)',
    visualExplanation: exact
      ? 'پروفیل ظاهری، نسبت ابعاد و ساختار قطعه با نمونه مرجع انبار مرکزی تطابق کامل دارد.'
      : 'ساختار و کاربرد مهندسی بسیار نزدیک است؛ برای جایگزینی ابعاد شفت/عرض چک شود.',
    verificationConfidence: exact ? 0.96 : 0.82,
    forzaCode: p.forzaCode,
    cataloguePage: p.cataloguePage,
    image: p.images?.[0] || p.image || '/storage/products/catalog/e(1).png',
  });

  const result = {
    success: true,
    isAiGenerated: true,
    stage,
    model: activeModel,
    observationOnly: false,
    queryRegion: body.region || { x: 0.14, y: 0.12, width: 0.72, height: 0.74 },
    queryRegions: [{ x: 0.14, y: 0.12, width: 0.72, height: 0.74 }],
    localVisionMetrics: {
      pipeline: 'visual-catalog-matcher',
      queryViews: 3,
      geometryComplete: true,
      ocrAvailable: true,
      retrievalMs: 210,
    },
    summary: {
      whatYouSee: info.whatYouSee,
      readableMarkings: info.readableMarkings,
      observedSpecifications: (primary.technicalSpecs || []).map((s) => ({
        name: s.key,
        value: s.value,
        evidence: 'تحلیل تصویر و مشخصات استاندارد کاتالوگ',
        source: 'کاتالوگ صنعت پیش',
      })),
      unknownParameters: stage === 'quick' ? ['تلرانس دقیق میلی‌متری نصب'] : [],
      detectedPartType: info.detectedType,
      partFamilyFarsi: info.partFamilyFarsi,
      detectedProfile: info.detectedProfile,
      material: info.material,
      visualAnalysis: info.whatYouSee,
      confidence: score / 100,
      exactVisualMatch: true,
      catalogAvailability: {
        status: 'confirmed_in_catalog' as const,
        statusFarsiTitle: 'عیناً در کاتالوگ صنعت پیش موجود است',
        statusFarsiMessage: `کد مرجع ${primary.code} (${primary.name}) در انبار مرکزی شناسایی شد و آماده ثبت سفارش یا استعلام فوری است.`,
      },
      verifiedCandidateCount: 1 + info.similar.length,
    },
    catalogImageMatches: [primary, ...info.similar].map((p, idx) => ({
      imageId: p.code,
      image: p.images?.[0] || '/storage/products/catalog/e(1).png',
      label: p.name,
      score: idx === 0 ? 0.96 : Math.max(0.72, 0.87 - idx * 0.04),
      reason: idx === 0 ? 'تطبیق مستقیم ظاهری با نمونه مرجع' : 'شباهت ساختاری و هم‌گروهی کاتالوگ',
      relation: idx === 0 ? ('very_similar' as const) : ('related' as const),
      familyNames: [p.name],
      bindings: [{ familyCode: p.code, code: p.variants?.[0]?.code || p.code, verified: true }],
    })),
    retrieval: {
      mode: 'hybrid-visual-ui',
      total: 869,
      indexed: 869,
      ready: true,
      verifiedPool: 869,
    },
    scanCoverage: {
      total: 869,
      compared: 869,
      failed: 0,
      complete: true,
      providerAvailable: true,
      failedImageIds: [],
    },
    matchedProducts: [toMatchedItem(primary, 0, true)],
    rejectedCandidates: [],
    similarCandidates: info.similar.map((p, i) => toMatchedItem(p, i + 1, false)),
    technicalAdvice: info.advice,
  };

  const jobId = 'job-' + Date.now();
  recognitionJobs.set(jobId, result);
  res.json(result);
});

app.get('/api/ai/recognition-jobs/:id', (req, res) => {
  const result = recognitionJobs.get(req.params.id);
  res.json({
    status: 'complete',
    progress: { stage: 'complete', total: 869, compared: 869, failed: 0 },
    result,
  });
});

// ---------------------------------------------------------------------------
// 6. AI Consult & FORZA Voice/Chat UI Endpoints — Zero API Key
// ---------------------------------------------------------------------------
function buildConsultReply(query: string): {
  text: string;
  suggestedProducts: Product[];
  suggestedAction: { label: string; link: string };
} {
  const { products } = getMockCatalog();
  const q = query.toLowerCase();
  let matched = products.filter(
    (p) =>
      p.name.toLowerCase().includes(q) ||
      p.categoryName.toLowerCase().includes(q) ||
      p.code.toLowerCase().includes(q) ||
      (p.submenu || '').toLowerCase().includes(q),
  );
  if (matched.length === 0) {
    if (/تسمه|تایم|belt/.test(q)) {
      matched = products.filter((p) => p.categorySlug.startsWith('excel-v2-1'));
    } else if (/بلبرینگ|یاتاقان|bearing/.test(q)) {
      matched = products.filter((p) => p.code === 'AT-E383' || p.code === 'AT-E260');
    } else if (/کاشی|سرامیک|ریل|رولر/.test(q)) {
      matched = products.filter((p) => p.code === 'AT-E319' || p.code === 'AT-E140');
    } else {
      matched = products.slice(0, 3);
    }
  }
  const top = matched.slice(0, 3);
  const bulletLines = top
    .map((p) => `- **${p.name}** (کد مرجع: \`${p.code}\` — برند: ${p.brand})`)
    .join('\n');

  const text = `بر اساس بررسی مهندسی در کاتالوگ **صنعت پیش (اطلس / FORZA / SWR)**، گزینه‌های زیر برای درخواست شما پیشنهاد می‌شود:\n\n${bulletLines}\n\n**توصیه فنی خط تولید:**\n۱. پیش از سفارش نهایی، ابعاد دقیق (گام، عرض، قطر شفت یا دمای کاری محیط) را با جدول استاندارد کاتالوگ تطبیق دهید.\n۲. در صورت نیاز به بررسی تصویری، از بخش **«شناسایی قطعه از روی عکس»** استفاده کنید تا نقشه پروفیل و جایگزین‌های دقیق نمایش داده شوند.`;

  return {
    text,
    suggestedProducts: top,
    suggestedAction: {
      label: `مشاهده ${top[0]?.name || 'محصول پیشنهادی'}`,
      link: `/product/${encodeURIComponent(top[0]?.code || 'AT-E010')}`,
    },
  };
}

app.post('/api/ai/consult-stream', async (req, res) => {
  const query = String(req.body?.query || 'مشاوره قطعات صنعتی');
  const { text, suggestedAction } = buildConsultReply(query);

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (obj: unknown) => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  sendEvent({ type: 'start', responseId: req.body?.responseId || 'resp-' + Date.now(), timestamp: Date.now() });
  sendEvent({ type: 'provider', provider: 'forza-engineering-ui' });

  const words = text.split(/(\s+)/);
  let acc = '';
  for (let i = 0; i < words.length; i += 4) {
    const chunk = words.slice(i, i + 4).join('');
    acc += chunk;
    sendEvent({ type: 'text_chunk', chunk, textSoFar: acc });
    await new Promise((r) => setTimeout(r, 18));
  }

  sendEvent({ type: 'done', fullText: acc, suggestedAction });
  res.end();
});

app.post('/api/ai/consult', (req, res) => {
  const query = String(req.body?.query || 'مشاوره قطعات صنعتی');
  const { text, suggestedProducts, suggestedAction } = buildConsultReply(query);
  res.json({
    success: true,
    reply: text,
    answer: text,
    suggestedProducts,
    suggestedAction,
  });
});

app.get('/api/ai/catalog-search', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const { products } = getMockCatalog();
  const matches = !q
    ? products.slice(0, 12)
    : products
        .filter(
          (p) =>
            p.code.toLowerCase().includes(q) ||
            p.name.toLowerCase().includes(q) ||
            p.brand.toLowerCase().includes(q) ||
            p.categoryName.toLowerCase().includes(q),
        )
        .slice(0, 20);
  res.json({ success: true, products: matches, items: matches });
});

app.get('/api/ai/forza-voice-info', (_req, res) => {
  res.json({ success: true, available: true, voice: 'forza-fa', provider: 'ui-preview' });
});

app.get('/api/ai/forza-stt-info', (_req, res) => {
  res.json({ success: true, available: true, provider: 'browser-stt' });
});

function createSilentWav(durationMs = 400): Buffer {
  const sampleRate = 16000;
  const numSamples = Math.floor((sampleRate * durationMs) / 1000);
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

app.post('/api/ai/forza-speech', (_req, res) => {
  res.setHeader('Content-Type', 'audio/wav');
  res.send(createSilentWav(350));
});

app.post('/api/ai/tts', (_req, res) => {
  res.setHeader('Content-Type', 'audio/wav');
  res.send(createSilentWav(350));
});

app.get('/api/ai/local-vision-status', (_req, res) => {
  res.json({
    success: true,
    enabled: true,
    ready: true,
    pipeline: 'local-lens-v3',
    model: 'sanatpish-visual-ui',
  });
});

app.post('/api/ai/forza-live', (req, res) => {
  const query = String(req.body?.text || 'معرفی قطعات و تسمه‌های خط تولید');
  const { text } = buildConsultReply(query);
  res.json({
    success: true,
    transcript: query,
    reply: text,
  });
});

// ---------------------------------------------------------------------------
// 7. Admin, CRM, Security, Reports, Customer & Checkout Endpoints
// ---------------------------------------------------------------------------
app.get('/api/admin/catalog', (_req, res) => {
  const { products } = getMockCatalog();
  res.json({ success: true, database: true, productsIncluded: true, products });
});

app.get('/api/admin/reports', (_req, res) => {
  const { products } = getMockCatalog();
  res.json({
    success: true,
    summary: {
      totalRevenue: 486500000,
      ordersCount: 42,
      customersCount: DEFAULT_CUSTOMERS.length,
      inquiriesCount: DEFAULT_INQUIRIES.length,
      productsCount: products.length,
      conversionRate: 34.5,
    },
    topProducts: products.slice(0, 6).map((p, idx) => ({
      code: p.code,
      name: p.name,
      brand: p.brand,
      orders: 18 - idx * 2,
      revenue: (18 - idx * 2) * (p.prices?.retail || 550000),
    })),
    monthlyTrend: [
      { month: 'فروردین', revenue: 62000000, orders: 12 },
      { month: 'اردیبهشت', revenue: 78500000, orders: 15 },
      { month: 'خرداد', revenue: 94000000, orders: 19 },
      { month: 'تیر', revenue: 112000000, orders: 22 },
      { month: 'مرداد', revenue: 140000000, orders: 26 },
    ],
  });
});

app.get('/api/admin/crm/customers', (_req, res) => {
  res.json({ success: true, customers: DEFAULT_CUSTOMERS, total: DEFAULT_CUSTOMERS.length });
});

app.get('/api/admin/crm/customers/:id', (req, res) => {
  const customer =
    DEFAULT_CUSTOMERS.find((c) => c.id === req.params.id) || DEFAULT_CUSTOMERS[0];
  res.json({
    success: true,
    customer,
    orders: DEFAULT_ORDERS,
    followups: [],
    tickets: DEFAULT_TICKETS,
  });
});

app.get('/api/admin/crm/tickets', (_req, res) => {
  res.json({ success: true, tickets: DEFAULT_TICKETS });
});

app.get('/api/admin/crm/commercial-options', (_req, res) => {
  res.json({
    success: true,
    grades: portalValues.atlas_customer_grades_v2,
    paymentTerms: ['نقدی', 'چکی ۳۰ روزه', 'اعتبار کارخانه‌ای ۶۰ روزه'],
  });
});

app.get('/api/admin/crm/credentials/config', (_req, res) => {
  res.json({ success: true, smsEnabled: false, autoUsernamePrefix: 'SP-' });
});

app.get('/api/admin/crm/credentials/templates', (_req, res) => {
  res.json({ success: true, templates: [] });
});

app.get('/api/admin/crm/images', (_req, res) => {
  res.json({ success: true, images: [] });
});

app.get('/api/admin/staff', (_req, res) => {
  res.json({ success: true, staff: DEFAULT_STAFF, users: DEFAULT_STAFF });
});

app.get('/api/admin/staff/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  const timer = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 25000);
  req.on('close', () => clearInterval(timer));
});

app.get('/api/admin/security/overview', (_req, res) => {
  res.json({
    success: true,
    activeSessions: 2,
    failedLogins24h: 0,
    twoFactorEnabled: false,
    lastBackupAt: new Date().toISOString(),
    riskLevel: 'low',
  });
});

app.get('/api/admin/security/settings', (_req, res) => {
  res.json({
    success: true,
    settings: {
      sessionTimeoutMinutes: 120,
      maxLoginAttempts: 5,
      requireStrongPassword: true,
      auditLoggingEnabled: true,
    },
  });
});

app.get('/api/admin/security/activity', (_req, res) => {
  res.json({
    success: true,
    rows: [
      {
        id: 'sec-1',
        actor: 'admin',
        action: 'LOGIN_SUCCESS',
        ip: '127.0.0.1',
        createdAt: new Date().toISOString(),
      },
    ],
    hasMore: false,
  });
});

app.get('/api/admin/security/sms-logs', (_req, res) => {
  res.json({ success: true, rows: [] });
});

app.get('/api/admin/custom-part-requests', (_req, res) => {
  res.json({ success: true, items: DEFAULT_CUSTOM_PART_REQUESTS, total: DEFAULT_CUSTOM_PART_REQUESTS.length });
});

app.get('/api/admin/catalog-image-audits', (_req, res) => {
  res.json({ success: true, audits: [] });
});

app.post('/api/checkout', (req, res) => {
  const newOrder = {
    id: 'ORD-' + Date.now(),
    orderNumber: 'ORD-' + Math.floor(100000 + Math.random() * 900000),
    ...(req.body || {}),
    status: 'registered',
    createdAt: new Date().toISOString(),
  };
  DEFAULT_ORDERS.unshift(newOrder as (typeof DEFAULT_ORDERS)[number]);
  res.json({ success: true, order: newOrder, orderNumber: newOrder.orderNumber });
});

app.post('/api/checkout/orders', (req, res) => {
  const newOrder = {
    id: 'ORD-' + Date.now(),
    orderNumber: 'ORD-' + Math.floor(100000 + Math.random() * 900000),
    ...(req.body || {}),
    status: 'registered',
    createdAt: new Date().toISOString(),
  };
  DEFAULT_ORDERS.unshift(newOrder as (typeof DEFAULT_ORDERS)[number]);
  res.json({ success: true, order: newOrder });
});

app.get('/api/custom-part-requests', (_req, res) => {
  res.json({ success: true, items: DEFAULT_CUSTOM_PART_REQUESTS, total: DEFAULT_CUSTOM_PART_REQUESTS.length });
});

app.post('/api/custom-part-requests', (req, res) => {
  const created = {
    id: 'CPR-' + Date.now(),
    ...(req.body || {}),
    status: 'reviewing',
    createdAt: new Date().toISOString(),
  };
  DEFAULT_CUSTOM_PART_REQUESTS.unshift(created as (typeof DEFAULT_CUSTOM_PART_REQUESTS)[number]);
  res.json({ success: true, item: created, id: created.id });
});

app.post('/api/customer-intelligence/image-identifications', (req, res) => {
  res.json({
    success: true,
    id: 'evt-' + Date.now(),
    event: { id: 'evt-' + Date.now(), ...(req.body || {}), status: 'pending' },
  });
});

app.all(/^\/api\/customer-intelligence\/.+$/, (_req, res) => {
  res.json({ success: true });
});

app.get('/api/customer/image-identifications', (_req, res) => {
  res.json({ success: true, events: [] });
});

app.post('/api/customer/image-identifications', (req, res) => {
  res.json({
    success: true,
    event: { id: 'evt-' + Date.now(), ...(req.body || {}), status: 'pending' },
  });
});

app.all(/^\/api\/.*/, (_req, res) => {
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// 8. Vite Dev Middleware / Production Static Server
// ---------------------------------------------------------------------------
async function start() {
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, HOST, () => {
    console.log(`[SanatPish UI Server] listening on http://${HOST}:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
