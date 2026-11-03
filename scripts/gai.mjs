// Официальные перечни мест установки камер с сайтов Госавтоинспекции регионов.
// По 257-ФЗ регионы публикуют их в разделе публикаций, обычно в PDF или Excel:
// адрес, координаты, направление и виды нарушений, которые фиксирует камера.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import readXlsxFile from 'read-excel-file/node';

import { FEATURE, featuresFromText } from './features.mjs';

const SITE = 'https://xn--80aebkobnwfcnsfk1e0h.xn--p1ai'; // госавтоинспекция.рф
const USER_AGENT = 'Mozilla/5.0 (bez-kamer data import)';

// Коды субъектов РФ, под которыми у Госавтоинспекции страницы /r/<код>/.
// Для проверки можно ограничить список: GAI_REGIONS=77,50 node scripts/import-osm.mjs
const REGION_CODES = process.env.GAI_REGIONS
  ? process.env.GAI_REGIONS.split(',').map(Number)
  : [...Array.from({ length: 89 }, (_, i) => i + 1), 91, 92];

// Файлы с камерами узнаём по названию.
const CAMERA_FILE = /stacion|statsion|fvf|kamer|sredstv[a-z_]*fiks|kompleks|фотовидео|стацион|камер|комплекс/i;
const MOBILE = /peredvizh|передвиж/i;
// Общий файл (стационарные и передвижные) часто назван сокращённо: stac., st_i_peredvizh.
const STATIONARY = /stac|stats|(^|[_\-.])st[_\-.]|стацион/i;
// Файлы, которые точно не перечни камер (статистика ДТП, доклады, презентации).
const OTHER_REPORTS = /statist|statitsik|dtp|дтп|статист|prezent|презент|doklad|доклад|otchet|отчет|отчёт/i;
// Заголовок раздела с передвижными камерами внутри общего файла.
const MOBILE_SECTION = /передвижн\S*\s+(средств|комплекс|камер)/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url, asBuffer = false) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } }).catch(() => null);
    if (res?.ok) return asBuffer ? Buffer.from(await res.arrayBuffer()) : res.text();
    if (res && res.status === 404) return null;
    await sleep(3000 * attempt);
  }
  return null;
}

/**
 * Самые свежие файлы региона: со стационарными камерами (или общий)
 * и отдельный с передвижными, если регион публикует их отдельно.
 */
async function findCameraFiles(code) {
  // Коды 1-9 на сайте двузначные: /r/07/, а /r/7/ отдаёт 404.
  const html = await fetchWithRetry(`${SITE}/r/${String(code).padStart(2, '0')}/`);
  if (!html) return [];
  // Ссылки на странице идут от новых к старым.
  const allLinks = [...html.matchAll(/href="([^"]+\.(pdf|xlsx))"/gi)].map((m) => m[1]);
  const links = allLinks.filter(
    (href) => CAMERA_FILE.test(decodeURIComponent(href)) || MOBILE.test(decodeURIComponent(href)),
  );
  const name = (href) => decodeURIComponent(href);
  // Первым на странице иногда стоит короткое дополнение, поэтому берём по 3 свежих кандидата,
  // а из них потом выбираем файл с наибольшим числом камер.
  const main = links.filter((href) => !MOBILE.test(name(href)) || STATIONARY.test(name(href))).slice(0, 3);
  const mobile = links.filter((href) => MOBILE.test(name(href)) && !STATIONARY.test(name(href))).slice(0, 3);
  // Некоторые регионы называют файл просто датой («30.10.2026.xlsx»). Если по названию
  // ничего не нашлось, проверяем свежие файлы региона по содержимому (strict: см. fetchGaiCameras).
  if (!main.length) {
    const unnamed = allLinks
      .filter((href) => href.includes(`/site${code}/`) && !OTHER_REPORTS.test(name(href)))
      .slice(0, 3);
    if (unnamed.length) return [{ urls: unnamed.map((href) => new URL(href, SITE).href), mobile: false, strict: true }];
  }
  return [
    main.length && { urls: main.map((href) => new URL(href, SITE).href), mobile: false },
    mobile.length && { urls: mobile.map((href) => new URL(href, SITE).href), mobile: true },
  ].filter(Boolean);
}

async function pdfToText(buffer) {
  const doc = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, verbosity: 0 }).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    let lastY = null;
    let line = '';
    for (const item of content.items) {
      const y = Math.round(item.transform[5]);
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        lines.push(line);
        line = '';
      }
      line += (line && !line.endsWith(' ') ? ' ' : '') + item.str;
      lastY = y;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

const COORD_PAIR = /(\d{2,3}[.,]\d{3,8})\s*[,;/\s]\s*(\d{2,3}[.,]\d{3,8})/g;
const toNum = (s) => parseFloat(s.replace(',', '.'));

// Россия: широта 41-82, долгота 19-180. Если числа перепутаны местами, меняем.
function asLatLon(a, b) {
  if (a >= 41 && a <= 82 && b >= 19 && b <= 180) return [a, b];
  if (b >= 41 && b <= 82 && a >= 19 && a <= 180) return [b, a];
  return null;
}

/**
 * Разбор сплошного текста таблицы: находим пары координат, а виды нарушений
 * берём из текста рядом. В одних таблицах нарушения идут после координат,
 * в других до них; направление определяем по тому, где текст есть у крайних записей.
 */
function parseText(text) {
  const matches = [...text.matchAll(COORD_PAIR)]
    .map((m) => ({ m, coords: asLatLon(toNum(m[1]), toNum(m[2])) }))
    .filter((x) => x.coords);
  if (!matches.length) return [];

  const mobileFrom = text.search(MOBILE_SECTION);
  const tailAfterLast = text.slice(matches.at(-1).m.index + matches.at(-1).m[0].length);
  const violationsAfter = featuresFromText(tailAfterLast) !== 0;

  return matches.map(({ m, coords }, i) => {
    const segment = violationsAfter
      ? text.slice(m.index + m[0].length, matches[i + 1]?.m.index ?? text.length)
      : text.slice(matches[i - 1] ? matches[i - 1].m.index + matches[i - 1].m[0].length : 0, m.index);
    const mobile = mobileFrom >= 0 && m.index > mobileFrom;
    return { lat: coords[0], lon: coords[1], features: featuresFromText(segment), mobile };
  });
}

/** В Excel каждая строка таблицы - одна камера. */
async function parseXlsx(buffer) {
  const sheets = await readXlsxFile(buffer, { getSheets: true });
  const result = [];
  for (const { name } of sheets) {
    const rows = await readXlsxFile(buffer, { sheet: name });
    for (const row of rows) {
      const text = row.map((cell) => (cell == null ? '' : String(cell))).join(' ; ');
      const [record] = parseText(text);
      // В таблицах тип камеры обычно в отдельной колонке: «передвижной», «передвижное средство».
      if (record) result.push({ ...record, features: featuresFromText(text), mobile: /передвижн/i.test(text) });
    }
  }
  return result;
}

/**
 * Камеры из официальных перечней всех регионов, где они опубликованы.
 * У передвижных (mobile: true) это места, где регион ставит мобильные камеры на треногах.
 */
export async function fetchGaiCameras(log = console.log) {
  const cameras = [];
  const covered = [];
  for (const code of REGION_CODES) {
    try {
      for (const file of await findCameraFiles(code)) {
        let records = [];
        for (const url of file.urls) {
          const buffer = await fetchWithRetry(url, true);
          if (!buffer) continue;
          const parsed = /\.xlsx$/i.test(url) ? await parseXlsx(buffer) : parseText(await pdfToText(buffer));
          // Файл, найденный не по названию, принимаем, только если это явно таблица камер:
          // хотя бы 5 точек, и у большинства распознаны виды нарушений.
          const looksLikeCameras = parsed.length >= 5 && parsed.filter((r) => r.features).length >= parsed.length / 2;
          if (file.strict && !looksLikeCameras) continue;
          if (parsed.length > records.length) {
            records = parsed;
            file.url = url;
          }
        }
        if (!records.length) continue;
        // Камера без единого распознанного нарушения всё равно камера: считаем её камерой скорости.
        for (const r of records) {
          cameras.push({ ...r, features: r.features || FEATURE.speed, mobile: r.mobile || file.mobile });
        }
        const mobileCount = records.filter((r) => r.mobile || file.mobile).length;
        if (records.length && !covered.includes(code)) covered.push(code);
        log(`  ГАИ, регион ${code}: ${records.length - mobileCount} стационарных, ${mobileCount} передвижных (${decodeURIComponent(file.url.split('/').pop())})`);
      }
    } catch (err) {
      log(`  ГАИ, регион ${code}: не удалось разобрать (${err.message})`);
    }
    await sleep(500);
  }
  log(`Официальные перечни найдены в ${covered.length} регионах`);
  return cameras;
}
