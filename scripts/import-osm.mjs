// Загружает камеры, посты ДПС и пункты оплаты платных дорог по всей России
// (и платные парковки крупных городов) из OpenStreetMap.
// Результат:
//   data/road-objects.json      - публикуется на сервере, приложение скачивает обновления;
//   src/map/data/osm.json       - копия внутри приложения на случай, если интернета нет
//                                 (пишется, только если скрипт запущен в папке приложения).
// Запуск: node scripts/import-osm.mjs [RU-MOW RU-SPE ...]  (без аргументов - вся Россия)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// Коды субъектов РФ по ISO 3166-2, как они размечены в OpenStreetMap.
const ALL_REGIONS = [
  'AD', 'AL', 'BA', 'BU', 'DA', 'IN', 'KB', 'KL', 'KC', 'KR', 'KO', 'ME', 'MO', 'SA', 'SE', 'TA', 'TY', 'UD',
  'CE', 'CU', 'ALT', 'KDA', 'KYA', 'PRI', 'STA', 'KHA', 'AMU', 'ARK', 'AST', 'BEL', 'BRY', 'VLA', 'VGG', 'VLG',
  'VOR', 'IVA', 'IRK', 'KGD', 'KLU', 'KAM', 'KEM', 'KIR', 'KOS', 'KGN', 'KRS', 'LEN', 'LIP', 'MAG', 'MOS', 'MUR',
  'NIZ', 'NGR', 'NVS', 'OMS', 'ORE', 'ORL', 'PNZ', 'PER', 'PSK', 'ROS', 'RYA', 'SAM', 'SAR', 'SAK', 'SVE', 'SMO',
  'TAM', 'TVE', 'TOM', 'TUL', 'TYU', 'ULY', 'CHE', 'ZAB', 'YAR', 'MOW', 'SPE', 'YEV', 'NEN', 'KHM', 'CHU', 'YAN',
].map((code) => `RU-${code}`);

// Платных парковок тысячи, берём их только там, где они массово есть.
const PARKING_REGIONS = new Set(['RU-MOW', 'RU-SPE']);

const SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

function queryFor(region) {
  const parking = PARKING_REGIONS.has(region) ? 'nwr["amenity"="parking"]["fee"="yes"](area.r);' : '';
  return `[out:json][timeout:180];area["ISO3166-2"="${region}"]->.r;(
    node["highway"="speed_camera"](area.r);
    node["police"="checkpoint"](area.r);
    node["barrier"="toll_booth"](area.r);
    ${parking}
  );out center tags;`;
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

function classify(tags) {
  if (tags.highway === 'speed_camera') return 'camera';
  if (tags.police === 'checkpoint') return 'police';
  if (tags.barrier === 'toll_booth') return 'toll';
  if (tags.amenity === 'parking') return 'parking';
  return null;
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

const regions = process.argv.slice(2).length ? process.argv.slice(2) : ALL_REGIONS;
const seen = new Set();
// Компактный формат: [тип, широта, долгота, ограничение, направление]
const rows = [];
const failed = [];

for (const [i, region] of regions.entries()) {
  try {
    const elements = await fetchRegion(region);
    let added = 0;
    for (const e of elements) {
      const type = classify(e.tags ?? {});
      const lat = e.lat ?? e.center?.lat;
      const lon = e.lon ?? e.center?.lon;
      if (!type || lat == null) continue;
      const key = `${type}:${lat.toFixed(5)}:${lon.toFixed(5)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push([type, +lat.toFixed(6), +lon.toFixed(6), parseSpeed(e.tags.maxspeed), parseDirection(e.tags.direction)]);
      added++;
    }
    console.log(`[${i + 1}/${regions.length}] ${region}: +${added}`);
  } catch (err) {
    console.warn(String(err));
    failed.push(region);
  }
  await sleep(1500);
}

// Если не скачался хотя бы один регион, файлы не перезаписываем: старая база лучше неполной.
if (failed.length) {
  console.error(`Не удалось загрузить: ${failed.join(', ')}. Файлы не изменены.`);
  process.exit(1);
}

// Версию меняем только при реальных изменениях, чтобы телефоны не качали ту же базу заново.
const previous = existsSync('data/road-objects.json') ? JSON.parse(readFileSync('data/road-objects.json', 'utf8')) : null;
const unchanged = previous && JSON.stringify(previous.rows) === JSON.stringify(rows);
const version = unchanged ? previous.version : new Date().toISOString();
const dataset = { version, source: 'OpenStreetMap contributors (ODbL)', rows };
mkdirSync('data', { recursive: true });
writeFileSync('data/road-objects.json', JSON.stringify(dataset));
// Копию внутрь приложения кладём, только если скрипт запущен в папке приложения.
if (existsSync('src/map')) {
  mkdirSync('src/map/data', { recursive: true });
  writeFileSync('src/map/data/osm.json', JSON.stringify(dataset));
}
const counts = rows.reduce((acc, [t]) => ({ ...acc, [t]: (acc[t] ?? 0) + 1 }), {});
console.log('Сохранено:', counts, `версия ${dataset.version}`);
