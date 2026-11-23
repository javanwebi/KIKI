import type { Product, ProductVariant } from '../src/types';
import {
  APPROVED_MENU_CATEGORIES,
  APPROVED_MENU_GROUPS,
} from '../src/data/approvedMenuFallback';
import { CATALOG_FAMILY_MENU_ASSIGNMENTS } from '../src/data/catalogMenuAssignmentsData';
import beltManifestRaw from '../src/generated/beltCatalogManifest';
import { CATEGORIES } from '../src/data/categories';
import { BRANDS } from '../src/data/brands';

type BeltManifestShape = {
  families: Record<string, { s: string; d: string; db: string | null; p: [string, string, string] }>;
  skus: Record<string, string>;
};

const beltManifest = beltManifestRaw as unknown as BeltManifestShape;

export type DirectSkuItem = {
  skuCode: string;
  name: string;
  categorySlug: string;
  categoryName: string;
  submenu: string;
  subcategory: string;
  brand: string;
  imageUrl: string | null;
  technicalSpecs: { key: string; value: string }[];
  priceSnapshot: Record<string, unknown>;
  sourceFamilyCode?: string | null;
  active: boolean;
};

const BRAND_NAMES = [
  'اس دبلیو آر (SWR)',
  'فورزا (FORZA)',
  'اپتی‌بلت (Optibelt)',
  'مگاداین (Megadyne)',
  'اس کا اف (SKF)',
  'گیتس (Gates)',
  'اطلس صنعت',
];

const SAMPLE_IMAGE_POOL = [
  1, 14, 25, 35, 60, 80, 120, 140, 170, 190, 210, 260, 280, 319, 383, 410, 445, 512, 560, 610, 680, 720, 790, 840,
];

function catalogImg(num: number): string {
  const safe = Math.max(1, Math.min(869, num));
  return `/storage/products/catalog/e(${safe}).png`;
}

function makePrices(base: number) {
  return {
    base,
    retail: Math.round(base * 1.15),
    wholesale: Math.round(base * 0.92),
    dealer: Math.round(base * 0.85),
    agency: Math.round(base * 0.82),
  };
}

function buildBeltSkusIndex(): Map<string, string[]> {
  const byFamily = new Map<string, string[]>();
  for (const [sku, fam] of Object.entries(beltManifest.skus || {})) {
    const list = byFamily.get(fam) || [];
    if (list.length < 12) {
      list.push(sku);
      byFamily.set(fam, list);
    }
  }
  return byFamily;
}

let cachedCatalog: {
  products: Product[];
  directSkus: DirectSkuItem[];
} | null = null;

export function getMockCatalog(): { products: Product[]; directSkus: DirectSkuItem[] } {
  if (cachedCatalog) return cachedCatalog;

  const products: Product[] = [];
  const directSkus: DirectSkuItem[] = [];
  const seenCodes = new Set<string>();
  const beltSkusByFamily = buildBeltSkusIndex();

  const pushProduct = (p: Product) => {
    const key = p.code.toLowerCase();
    if (seenCodes.has(key)) return;
    seenCodes.add(key);
    products.push(p);
  };

  // 1. Visual recognition preset + flagship homepage preview families
  const flagshipSpecs: Array<{
    code: string;
    name: string;
    nameEn: string;
    brand: string;
    categorySlug: string;
    categoryName: string;
    submenu: string;
    subcategory: string;
    imgNum: number;
    basePrice: number;
    unit: string;
    specs: { key: string; value: string }[];
    variants: ProductVariant[];
  }> = [
    {
      code: 'AT-E001',
      name: 'حلقه تخت آب‌بندی و واشر صنعتی دقیق',
      nameEn: 'Precision Industrial Flat Ring Seal',
      brand: 'فورزا (FORZA)',
      categorySlug: 'excel-v2-7-1',
      categoryName: 'واشرها و آب‌بندی خطوط تولید',
      submenu: 'واشر و رینگ صنعتی',
      subcategory: 'حلقه تخت پلیمری و فلزی',
      imgNum: 1,
      basePrice: 185000,
      unit: 'عدد',
      specs: [
        { key: 'متریال', value: 'پلی‌اورتان / PTFE مقاوم به سایش' },
        { key: 'تحمل حرارت', value: '-۲۰ تا +۱۸۰ درجه سانتی‌گراد' },
        { key: 'کاربرد', value: 'آب‌بندی شفت و جک خط تولید کاشی' },
      ],
      variants: [
        { code: '41349', size: '32x48x4 mm', name: 'حلقه تخت سایز 32x48', price: 185000, stock: 120 },
        { code: '41350', size: '40x60x5 mm', name: 'حلقه تخت سایز 40x60', price: 220000, stock: 85 },
      ],
    },
    {
      code: 'AT-E014',
      name: 'پیچ دسته‌دار کلمپ صنعتی ستاره‌ای',
      nameEn: 'Industrial Star Knob Clamping Screw',
      brand: 'اطلس صنعت',
      categorySlug: 'excel-v2-3-3',
      categoryName: 'پیچ، مهره و نگهدارنده‌های خط',
      submenu: 'پیچ و دستگیره تنظیم',
      subcategory: 'پیچ دسته‌دار صنعتی',
      imgNum: 14,
      basePrice: 145000,
      unit: 'عدد',
      specs: [
        { key: 'رزوه', value: 'M8 / M10 فولاد آبکاری‌شده' },
        { key: 'جنس دسته', value: 'باکالیت مهندسی ضد ضربه' },
        { key: 'کاربرد', value: 'تنظیم گاید و ریل نقاله خطوط بسته‌بندی' },
      ],
      variants: [
        { code: '14001', size: 'M8 x 30 mm', name: 'پیچ دسته‌دار M8x30', price: 145000, stock: 240 },
        { code: '14002', size: 'M10 x 40 mm', name: 'پیچ دسته‌دار M10x40', price: 175000, stock: 160 },
      ],
    },
    {
      code: 'AT-E319',
      name: 'ریل راهنمای خطی و پروفیل هدایت سرامیک',
      nameEn: 'Industrial Conveyor Guide Rail Profile',
      brand: 'اس دبلیو آر (SWR)',
      categorySlug: 'excel-v2-6-1',
      categoryName: 'انواع ریل و گاید لاین نقاله',
      submenu: 'ریل و پروفیل هدایت',
      subcategory: 'ریل خطی مقاوم به سایش',
      imgNum: 319,
      basePrice: 890000,
      unit: 'شاخه',
      specs: [
        { key: 'طول استاندارد', value: '۲ و ۳ متر' },
        { key: 'آلیاژ / روکش', value: 'آلومینیوم آنودایز با لاینر UHMW-PE' },
        { key: 'کاربرد', value: 'هدایت کاشی، بطری و قطعات روی نقاله' },
      ],
      variants: [
        { code: '31901', size: '2000 x 38 mm', name: 'ریل صنعتی 2 متری', price: 890000, stock: 45 },
        { code: '31902', size: '3000 x 38 mm', name: 'ریل صنعتی 3 متری', price: 1290000, stock: 30 },
      ],
    },
    {
      code: 'AT-E383',
      name: 'بلبرینگ و یاتاقان صنعتی دور بالا SKF / FORZA',
      nameEn: 'Heavy-Duty Industrial Ball Bearing',
      brand: 'اس کا اف (SKF)',
      categorySlug: 'excel-v2-13-2',
      categoryName: 'یاتاقان و بلبرینگ صنعتی',
      submenu: 'انواع یاتاقان و بلبرینگ',
      subcategory: 'بلبرینگ شیار عمیق صنعتی',
      imgNum: 383,
      basePrice: 640000,
      unit: 'عدد',
      specs: [
        { key: 'کد فنی', value: '6206-2RS / UCP 206' },
        { key: 'آب‌بندی', value: 'دو طرفه نمدی/پلیمری ضد غبار' },
        { key: 'تحمل بار', value: 'دور بالا و خطوط لرزشی کاشی و نساجی' },
      ],
      variants: [
        { code: '38301', size: '30x62x16 mm (6206-2RS)', name: 'بلبرینگ 6206-2RS', price: 640000, stock: 95 },
        { code: '38302', size: '35x72x17 mm (6207-2RS)', name: 'بلبرینگ 6207-2RS', price: 780000, stock: 64 },
      ],
    },
  ];

  for (const item of flagshipSpecs) {
    const img = catalogImg(item.imgNum);
    pushProduct({
      code: item.code,
      name: item.name,
      nameEn: item.nameEn,
      brand: item.brand,
      categorySlug: item.categorySlug,
      categoryName: item.categoryName,
      submenu: item.submenu,
      subcategory: item.subcategory,
      technicalSpecs: item.specs,
      prices: makePrices(item.basePrice),
      stock: 150,
      stockKnown: true,
      inquiryOnly: false,
      rating: 4.9,
      images: [img],
      image: img,
      galleryImages: [{ id: `${item.code}-1`, url: img, scope: 'family', identityVerified: true }],
      tags: ['پرفروش', 'تأییدشده', 'کاتالوگ ۱۴۰۴'],
      unit: item.unit,
      featured: true,
      active: true,
      forzaCode: `FORZACODE: ${item.imgNum}00 1`,
      cataloguePage: 12 + item.imgNum,
      hasCatalogueImage: true,
      description: `${item.name} با استاندارد کنترل کیفیت صنعتی اطلس، مناسب کارکرد مداوم در خطوط تولید سنگین.`,
      variants: item.variants.map((v) => ({
        ...v,
        brand: item.brand,
        unit: item.unit,
        images: [img],
        prices: makePrices(v.price || item.basePrice),
        active: true,
      })),
    });
  }

  // 2. Homepage preferred preview codes (AT-E010 .. AT-E280)
  const homePreviewDefs: Array<[string, string, string, string, string, number]> = [
    ['AT-E010', 'تسمه تایمینگ صنعتی HTD 8M سیم‌دار', 'اس دبلیو آر (SWR)', 'excel-v2-1-1', 'تسمه تایمینگ صنعتی', 10],
    ['AT-E025', 'تسمه V-Belt اسپشیال SPB دنده‌دار فورزا', 'فورزا (FORZA)', 'excel-v2-1-2', 'تسمه وی بلت اسپشیال', 25],
    ['AT-E035', 'نوار نقاله PVC مقاوم به سایش خط سورتینگ', 'فورزا (FORZA)', 'excel-v2-2-1', 'نوار نقاله صنعتی', 35],
    ['AT-E060', 'پولی تایمینگ آلومینیومی T10 ماشین‌کاری CNC', 'اطلس صنعت', 'excel-v2-4-1', 'پولی و دنده تایمینگ', 60],
    ['AT-E080', 'تسمه گرد پلی‌اورتان سبز ۷ میلی‌متری', 'اس دبلیو آر (SWR)', 'excel-v2-1-3', 'تسمه گرد و جوشی PU', 80],
    ['AT-E120', 'کوپلینگ انعطاف‌پذیر فکی و الاستومر ضربه‌گیر', 'اطلس صنعت', 'excel-v2-4-2', 'کوپلینگ انتقال قدرت', 120],
    ['AT-E140', 'رولر و غلتک سیلیکونی خط لعاب کاشی', 'اس دبلیو آر (SWR)', 'excel-v2-3-1', 'رولر و غلطک سرامیکی', 140],
    ['AT-E170', 'زنجیر انتقال قدرت دو ردیفه ۱۶B فولادی', 'گیتس (Gates)', 'excel-v2-9-1', 'زنجیر صنعتی و چرخ‌دنده', 170],
    ['AT-E190', 'برس استوانه‌ای پرداخت و گردگیری سرامیک', 'اطلس صنعت', 'excel-v2-5-1', 'برس‌های صنعتی خط تولید', 190],
    ['AT-E210', 'پد مکنده و وکیوم سیلیکونی استکر کاشی', 'فورزا (FORZA)', 'excel-v2-7-2', 'قطعات وکیوم و مکش', 210],
    ['AT-E260', 'یاتاقان ایستاده UCP 208 سنگین‌کار', 'اس کا اف (SKF)', 'excel-v2-13-2', 'یاتاقان و بلبرینگ صنعتی', 260],
    ['AT-E280', 'نوار نسوز تفلونی PTFE چسب‌دار حرارتی', 'مگاداین (Megadyne)', 'excel-v2-8-1', 'نسوزها و نوار تفلون', 280],
  ];

  for (const [code, name, brand, catSlug, catName, imgNum] of homePreviewDefs) {
    const img = catalogImg(imgNum);
    const base = 420000 + imgNum * 3500;
    pushProduct({
      code,
      name,
      nameEn: `${brand} ${code}`,
      brand,
      categorySlug: catSlug,
      categoryName: catName,
      submenu: catName,
      subcategory: catName,
      technicalSpecs: [
        { key: 'برند سازنده', value: brand },
        { key: 'سری مهندسی', value: code },
        { key: 'استاندارد', value: 'ISO 9001 / DIN صنعتی' },
      ],
      prices: makePrices(base),
      stock: 40 + (imgNum % 80),
      stockKnown: true,
      inquiryOnly: false,
      rating: 4.8,
      images: [img],
      image: img,
      tags: ['پیشنهاد ویژه', 'تأمین مستقیم'],
      unit: 'عدد',
      featured: true,
      active: true,
      forzaCode: `FORZACODE: ${imgNum} 2`,
      cataloguePage: 20 + (imgNum % 90),
      hasCatalogueImage: true,
      description: `${name} عرضه مستقیم از انبار مرکزی صنعت پیش با گارانتی اصالت فنی و ارسال سریع سراسر کشور.`,
      variants: [
        {
          code: `${code}-A`,
          size: 'سایز استاندارد A',
          name: `${name} - سایز استاندارد`,
          brand,
          unit: 'عدد',
          price: base,
          prices: makePrices(base),
          stock: 42,
          images: [img],
          active: true,
        },
        {
          code: `${code}-B`,
          size: 'سایز تقویت‌شده B',
          name: `${name} - سایز صنعتی سنگین`,
          brand,
          unit: 'عدد',
          price: Math.round(base * 1.25),
          prices: makePrices(Math.round(base * 1.25)),
          stock: 18,
          images: [img],
          active: true,
        },
      ],
    });
  }

  // 3. Real Belt Families from beltCatalogManifest.ts (with authentic FAM-* codes & belt CAD/photos!)
  const beltCategoryNames: Record<string, string> = {
    'excel-v2-1-1': 'انواع تسمه‌های تایمینگ صنعتی',
    'excel-v2-1-2': 'تسمه‌های V-Belt کلاسیک و اسپشیال',
    'excel-v2-1-3': 'تسمه گرد، پنتاگونال و جوشی پلی‌اورتان',
    'excel-v2-1-4': 'تسمه تخت انتقال نیرو و فلت',
  };

  let beltCount = 0;
  for (const [famCode, entry] of Object.entries(beltManifest.families || {})) {
    if (beltCount >= 64) break;
    const assign = CATALOG_FAMILY_MENU_ASSIGNMENTS[famCode];
    const catSlug = assign?.categorySlug || entry.s || 'excel-v2-1-1';
    const submenu = assign?.submenuName || 'تسمه انتقال نیرو';
    const leaf = assign?.leafName || 'سایزهای استاندارد صنعتی';
    const skus = beltSkusByFamily.get(famCode) || [famCode.replace('FAM-', '')];
    const imgUrl = entry.db && entry.db.startsWith('/storage/')
      ? entry.db
      : `/src/assets/catalog/belts/families/${encodeURIComponent(famCode)}/family-image-01.webp`;

    const variants: ProductVariant[] = skus.map((sku, idx) => ({
      code: sku,
      size: `${leaf} — کد ${sku}`,
      name: `تسمه ${submenu} کد ${sku}`,
      brand: idx % 2 === 0 ? 'اس دبلیو آر (SWR)' : 'فورزا (FORZA)',
      unit: 'حلقه',
      price: 540000 + idx * 45000,
      prices: makePrices(540000 + idx * 45000),
      stock: 25 + idx * 5,
      stockKnown: true,
      active: true,
      images: [
        `/src/assets/catalog/belts/skus/${encodeURIComponent(sku)}/profile-drawing.webp`,
      ],
    }));

    pushProduct({
      code: famCode,
      name: `خانواده تسمه ${submenu} (${leaf}) — ${famCode}`,
      nameEn: `Industrial Belt ${famCode}`,
      brand: beltCount % 2 === 0 ? 'اس دبلیو آر (SWR)' : 'فورزا (FORZA)',
      categorySlug: catSlug,
      categoryName: beltCategoryNames[catSlug] || 'انواع تسمه‌های صنعتی',
      submenu,
      subcategory: leaf,
      technicalSpecs: [
        { key: 'بخش کاتالوگ', value: submenu },
        { key: 'پروفیل / گام', value: leaf },
        { key: 'ساختار تقویتی', value: 'کورد فایبرگلاس / استیل‌کورد مقاوم به کشش' },
        { key: 'کد خانواده', value: famCode },
      ],
      prices: makePrices(540000),
      stock: 80,
      stockKnown: true,
      inquiryOnly: false,
      rating: 4.9,
      images: [imgUrl],
      image: imgUrl,
      tags: ['تسمه صنعتی', submenu, 'نقشه مهندسی'],
      unit: 'حلقه',
      featured: beltCount < 8,
      active: true,
      forzaCode: `FORZACODE: ${famCode.replace('FAM-', '')}`,
      cataloguePage: 30 + beltCount,
      hasCatalogueImage: true,
      description: `خانواده تسمه صنعتی ${submenu} (${leaf}) دارای نقشه‌های مهندسی پروفیل و جدول ابعاد استاندارد برای خطوط تولید.`,
      variants,
    });
    beltCount++;
  }

  // 4. Populate EVERY excel-v2 category in APPROVED_MENU_CATEGORIES with real FAM-* assignments
  const assignmentsByCategory = new Map<string, Array<{ code: string; submenu: string; leaf: string | null }>>();
  for (const [famCode, assign] of Object.entries(CATALOG_FAMILY_MENU_ASSIGNMENTS)) {
    const list = assignmentsByCategory.get(assign.categorySlug) || [];
    if (list.length < 10) {
      list.push({ code: famCode, submenu: assign.submenuName, leaf: assign.leafName });
      assignmentsByCategory.set(assign.categorySlug, list);
    }
  }

  let idxCounter = 0;
  for (const cat of APPROVED_MENU_CATEGORIES) {
    const famList = assignmentsByCategory.get(cat.slug) || [];
    const fallbackItems =
      famList.length > 0
        ? famList
        : [
            {
              code: `FAM-DEMO-${cat.slug.replace('excel-v2-', '')}`,
              submenu: cat.subcategories[0] || cat.name,
              leaf: cat.children?.[0]?.children?.[0]?.name || cat.name,
            },
          ];

    for (const item of fallbackItems) {
      const imgNum = SAMPLE_IMAGE_POOL[idxCounter % SAMPLE_IMAGE_POOL.length];
      const img = catalogImg(imgNum);
      const brand = BRAND_NAMES[idxCounter % BRAND_NAMES.length];
      const base = 310000 + (idxCounter % 15) * 95000;
      const skuNum = item.code.replace(/[^0-9]/g, '') || String(70000 + idxCounter);

      pushProduct({
        code: item.code,
        name: `${item.leaf || item.submenu} — ${cat.name}`,
        nameEn: `${cat.nameEn || 'Industrial Part'} ${item.code}`,
        brand,
        categorySlug: cat.slug,
        categoryName: cat.name,
        submenu: item.submenu,
        subcategory: item.leaf || item.submenu,
        technicalSpecs: [
          { key: 'زیرگروه', value: item.submenu },
          { key: 'مشخصه فنی', value: item.leaf || cat.name },
          { key: 'برند', value: brand },
        ],
        prices: makePrices(base),
        stock: 30 + (idxCounter % 70),
        stockKnown: true,
        inquiryOnly: idxCounter % 7 === 0,
        rating: 4.7,
        images: [img],
        image: img,
        tags: [cat.name, item.submenu],
        unit: 'عدد',
        featured: idxCounter % 9 === 0,
        active: true,
        forzaCode: `FORZACODE: ${skuNum}`,
        cataloguePage: 15 + (idxCounter % 140),
        hasCatalogueImage: true,
        description: `${item.leaf || item.submenu} از گروه ${cat.name}؛ قابل تأمین فوری با مشاوره مهندسی صنعت پیش.`,
        variants: [
          {
            code: `${skuNum}1`,
            size: 'مدل استاندارد خط تولید',
            name: `${item.leaf || item.submenu} کد ${skuNum}1`,
            brand,
            unit: 'عدد',
            price: base,
            prices: makePrices(base),
            stock: 28,
            images: [img],
            active: true,
          },
          {
            code: `${skuNum}2`,
            size: 'مدل مقاوم صنعتی',
            name: `${item.leaf || item.submenu} کد ${skuNum}2`,
            brand,
            unit: 'عدد',
            price: Math.round(base * 1.2),
            prices: makePrices(Math.round(base * 1.2)),
            stock: 16,
            images: [img],
            active: true,
          },
        ],
      });

      directSkus.push({
        skuCode: `${skuNum}9`,
        name: `قطعه مستقیم ${item.leaf || item.submenu} — ${brand}`,
        categorySlug: cat.slug,
        categoryName: cat.name,
        submenu: item.submenu,
        subcategory: item.leaf || item.submenu,
        brand,
        imageUrl: img,
        technicalSpecs: [
          { key: 'کد فنی', value: `${skuNum}9` },
          { key: 'زیرمجموعه', value: item.submenu },
        ],
        priceSnapshot: makePrices(base),
        sourceFamilyCode: item.code,
        active: true,
      });

      idxCounter++;
    }
  }

  // 5. Ensure primary legacy CATEGORIES slugs also have products for /category/:slug pages
  for (let i = 0; i < CATEGORIES.length; i++) {
    const cat = CATEGORIES[i];
    const hasSome = products.some((p) => p.categorySlug === cat.slug);
    if (!hasSome) {
      const img = catalogImg(SAMPLE_IMAGE_POOL[(i * 3) % SAMPLE_IMAGE_POOL.length]);
      const brand = BRANDS[i % BRANDS.length]?.name || 'اطلس صنعت';
      const base = 480000 + i * 75000;
      pushProduct({
        code: `FAM-CAT-${i + 101}`,
        name: `${cat.name} — سری مهندسی خط تولید`,
        nameEn: cat.nameEn,
        brand,
        categorySlug: cat.slug,
        categoryName: cat.name,
        submenu: cat.subcategories[0] || cat.name,
        subcategory: cat.subcategories[0] || cat.name,
        technicalSpecs: [
          { key: 'دسته‌بندی', value: cat.name },
          { key: 'کاربرد صنعتی', value: 'خطوط تولید مداوم' },
        ],
        prices: makePrices(base),
        stock: 50,
        stockKnown: true,
        inquiryOnly: false,
        rating: 4.8,
        images: [img],
        image: img,
        tags: [cat.name, 'کاتالوگ رسمی'],
        unit: 'عدد',
        featured: true,
        active: true,
        forzaCode: `FORZACODE: 90${i}`,
        cataloguePage: 10 + i,
        hasCatalogueImage: true,
        description: cat.description,
        variants: [
          {
            code: `90${i}01`,
            size: 'استاندارد صنعتی',
            name: `${cat.name} مدل 90${i}01`,
            brand,
            unit: 'عدد',
            price: base,
            prices: makePrices(base),
            stock: 50,
            images: [img],
            active: true,
          },
        ],
      });
    }
  }

  cachedCatalog = { products, directSkus };
  return cachedCatalog;
}

export function getApprovedNavigationGroups() {
  return APPROVED_MENU_GROUPS;
}

export function getApprovedCategories() {
  return APPROVED_MENU_CATEGORIES;
}
