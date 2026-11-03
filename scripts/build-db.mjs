// Собирает единую базу камер, постов ДПС и пунктов оплаты платных дорог по всей России
// из нескольких источников и склеивает дубли:
//   1. OpenStreetMap (камеры, связи enforcement, посты, пункты оплаты);
//   2. официальные перечни Госавтоинспекции регионов (см. gai.mjs).
// Результат:
//   data/road-objects.json  - публикуется, приложение скачивает обновления;
//   src/map/data/osm.json   - копия внутри приложения (если скрипт запущен в его папке).
// Запуск: node scripts/build-db.mjs [RU-MOW RU-SPE ...]  (без аргументов - вся Россия)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { FEATURE, featuresFromOsm } from './features.mjs';
import { fetchGaiCameras } from './gai.mjs';

// Коды субъектов РФ по ISO 3166-2, как они размечены в OpenStreetMap.
const ALL_REGIONS = [
  'AD', 'AL', 'BA', 'BU', 'DA', 'IN', 'KB', 'KL', 'KC', 'KR', 'KO', 'ME', 'MO', 'SA', 'SE', 'TA', 'TY', 'UD',
  'CE', 'CU', 'ALT', 'KDA', 'KYA', 'PRI', 'STA', 'KHA', 'AMU', 'ARK', 'AST', 'BEL', 'BRY', 'VLA', 'VGG', 'VLG',
  'VOR', 'IVA', 'IRK', 'KGD', 'KLU', 'KAM', 'KEM', 'KIR', 'KOS', 'KGN', 'KRS', 'LEN', 'LIP', 'MAG', 'MOS', 'MUR',
  'NIZ', 'NGR', 'NVS', 'OMS', 'ORE', 'ORL', 'PNZ', 'PER', 'PSK', 'ROS', 'RYA', 'SAM', 'SAR', 'SAK', 'SVE', 'SMO',
  'TAM', 'TVE', 'TOM', 'TUL', 'TYU', 'ULY', 'CHE', 'ZAB', 'YAR', 'MOW', 'SPE', 'YEV', 'NEN', 'KHM', 'CHU', 'YAN',
].map((code) => `RU-${code}`);

const SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

// Источники точки (битовая маска): по ним в приложении видно, насколько камера подтверждена.
const SOURCE = { osm: 1, gai: 2 };

// Точки одного типа ближе этого расстояния считаем одним объектом.
const MERGE_DISTANCE_M = 40;

function queryFor(region) {
  return `[out:json][timeout:180];area["ISO3166-2"="${region}"]->.r;(
    node["highway"="speed_camera"](area.r);
    node["police"="checkpoint"](area.r);
    node["barrier"="toll_booth"](area.r);
  )->.objects;
  rel["type"="enforcement"](area.r)->.enforcement;
  node(r.enforcement:"device")->.devices;
  (.objects; .enforcement; .devices;);
  out body;`;
}

// Значения maxspeed вида RU:urban переводим в км/ч.
const SPEED_ZONES = { 'RU:urban': 60, 'RU:rural': 90, 'RU:motorway': 110, 'RU:living_street': 20 };

function parseSpeed(value) {
  if (!value) return null;
  if (SPEED_ZONES[value]) return SPEED_ZONES[value];
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function parseDirection(value) {
  if (!value) return null;
  const n = parseInt(String(value).split(';')[0], 10);
  return Number.isFinite(n) ? n : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Overpass часто отвечает 502/504/429 под нагрузкой, поэтому несколько попыток с паузой.
async function fetchRegion(region) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    for (const url of SERVERS) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': 'bez-kamer/0.1 (data import)' },
        body: new URLSearchParams({ data: queryFor(region) }),
      }).catch(() => null);
      if (res?.ok) {
        const body = await res.json().catch(() => null);
        if (body?.elements) return body.elements;
      }
    }
    await sleep(10000 * attempt);
  }
  throw new Error(`${region}: Overpass недоступен, попробуйте позже`);
}

/** Объекты OpenStreetMap одного региона. */
function osmObjects(elements) {
  const nodes = new Map(elements.filter((e) => e.type === 'node').map((e) => [e.id, e]));
  const result = [];

  for (const e of elements) {
    if (e.type !== 'node') continue;
    const t = e.tags ?? {};
    let type = null;
    if (t.highway === 'speed_camera') type = 'camera';
    else if (t.police === 'checkpoint') type = 'police';
    else if (t.barrier === 'toll_booth') type = 'toll';
    if (!type) continue;
    result.push({
      type,
      lat: e.lat,
      lon: e.lon,
      speed: parseSpeed(t.maxspeed),
      dir: parseDirection(t.direction),
      features: type === 'camera' ? featuresFromOsm(t.enforcement) : 0,
    });
  }

  // Связи enforcement: что именно фиксирует камера (device) и с каким ограничением.
  for (const rel of elements) {
    if (rel.type !== 'relation') continue;
    const features = featuresFromOsm(rel.tags?.enforcement);
    for (const member of rel.members ?? []) {
      const node = member.role === 'device' && nodes.get(member.ref);
      if (!node) continue;
      result.push({
        type: 'camera',
        lat: node.lat,
        lon: node.lon,
        speed: parseSpeed(rel.tags?.maxspeed ?? node.tags?.maxspeed),
        dir: parseDirection(node.tags?.direction),
        features,
      });
    }
  }
  return result.map((o) => ({ ...o, sources: SOURCE.osm }));
}

const toRad = (deg) => (deg * Math.PI) / 180;
function distanceM(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

/**
 * Склейка дублей: точки одного типа ближе MERGE_DISTANCE_M становятся одной.
 * Виды нарушений и источники объединяются, ограничение и направление берём первое известное.
 */
function mergeDuplicates(objects) {
  const cell = (deg) => Math.floor(deg / 0.001); // ячейка ~100 м
  const grid = new Map();
  const merged = [];
  for (const o of objects) {
    let target = null;
    for (let dy = -1; dy <= 1 && !target; dy++) {
      for (let dx = -1; dx <= 1 && !target; dx++) {
        for (const candidate of grid.get(`${cell(o.lat) + dy}:${cell(o.lon) + dx}`) ?? []) {
          if (candidate.type === o.type && distanceM(candidate, o) <= MERGE_DISTANCE_M) {
            target = candidate;
            break;
          }
        }
      }
    }
    if (target) {
      target.features |= o.features;
      target.sources |= o.sources;
      target.speed ??= o.speed;
      target.dir ??= o.dir;
      continue;
    }
    const copy = { ...o };
    merged.push(copy);
    const key = `${cell(o.lat)}:${cell(o.lon)}`;
    grid.set(key, [...(grid.get(key) ?? []), copy]);
  }
  return merged;
}

// ---------- сборка ----------

const regions = process.argv.slice(2).length ? process.argv.slice(2) : ALL_REGIONS;
const objects = [];
const failed = [];

console.log('OpenStreetMap:');
for (const [i, region] of regions.entries()) {
  try {
    const found = osmObjects(await fetchRegion(region));
    objects.push(...found);
    console.log(`  [${i + 1}/${regions.length}] ${region}: ${found.length}`);
  } catch (err) {
    console.warn(`  ${err}`);
    failed.push(region);
  }
  await sleep(1500);
}

// Если не скачался хотя бы один регион, базу не перезаписываем: старая лучше неполной.
if (failed.length) {
  console.error(`Не удалось загрузить: ${failed.join(', ')}. Файлы не изменены.`);
  process.exit(1);
}

console.log('Госавтоинспекция:');
// Передвижные камеры из официальных перечней - это места, где ставят треноги.
const gai = (await fetchGaiCameras((line) => console.log(line))).map((c) => ({
  type: c.mobile ? 'tripod' : 'camera',
  lat: c.lat,
  lon: c.lon,
  speed: null,
  dir: null,
  features: c.features,
  sources: SOURCE.gai,
}));

const previous = existsSync('data/road-objects.json') ? JSON.parse(readFileSync('data/road-objects.json', 'utf8')) : null;
// Сайт Госавтоинспекции может временно не работать: если официальных камер стало
// вдвое меньше, чем в прошлой базе, ничего не перезаписываем.
const previousGai = (previous?.rows ?? []).filter((r) => (r[6] ?? 0) & SOURCE.gai).length;
if (previousGai > 0 && gai.length < previousGai / 2) {
  console.error(`Официальных камер ${gai.length}, а было ${previousGai}. Похоже на сбой сайта, файлы не изменены.`);
  process.exit(1);
}

// Сначала официальные данные: при склейке их виды нарушений главнее.
const all = mergeDuplicates([...gai, ...objects]).map((o) => {
  // Камера, про которую ничего не известно, по умолчанию считается камерой скорости.
  if ((o.type === 'camera' || o.type === 'tripod') && !o.features) o.features = FEATURE.speed;
  return o;
});

// Компактный формат строки (тип: camera, tripod, police, toll): [тип, широта, долгота, ограничение, направление, нарушения, источники]
const rows = all
  .map((o) => [o.type, +o.lat.toFixed(6), +o.lon.toFixed(6), o.speed, o.dir, o.features, o.sources])
  .sort((a, b) => a[1] - b[1] || a[2] - b[2]);

// Версию меняем только при реальных изменениях, чтобы телефоны не качали ту же базу заново.
const unchanged = previous && JSON.stringify(previous.rows) === JSON.stringify(rows);
const version = unchanged ? previous.version : new Date().toISOString();
const dataset = {
  version,
  source: 'OpenStreetMap contributors (ODbL); перечни мест установки камер Госавтоинспекции регионов',
  rows,
};
mkdirSync('data', { recursive: true });
writeFileSync('data/road-objects.json', JSON.stringify(dataset));
// Копию внутрь приложения кладём, только если скрипт запущен в папке приложения.
if (existsSync('src/map')) {
  mkdirSync('src/map/data', { recursive: true });
  writeFileSync('src/map/data/osm.json', JSON.stringify(dataset));
}

const counts = rows.reduce((acc, [t]) => ({ ...acc, [t]: (acc[t] ?? 0) + 1 }), {});
const bySource = rows.reduce((acc, r) => ({ ...acc, [r[6]]: (acc[r[6]] ?? 0) + 1 }), {});
console.log('Сохранено:', counts, 'по источникам (1 - OSM, 2 - ГАИ, 3 - оба):', bySource, `версия ${version}`);
