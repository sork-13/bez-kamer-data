// Что фиксирует камера. Хранится в базе битовой маской, чтобы занимать мало места.
// Тот же список есть в приложении (src/map/camera-features.ts): номера битов менять нельзя.
export const FEATURE = {
  speed: 1, // превышение скорости
  redLight: 2, // проезд на красный
  stopLine: 4, // выезд за стоп-линию
  busLane: 8, // полоса для маршрутных ТС
  marking: 16, // сплошная, разметка, островок
  pedestrian: 32, // не пропустил пешехода
  seatbelt: 64, // ремни, телефон
  stopping: 128, // остановка и стоянка
  turn: 256, // повороты, развороты, движение по знакам
  shoulder: 512, // движение по обочине
  truck: 1024, // грузовики, ограничения для грузовых
  avgSpeed: 2048, // средняя скорость на участке
  railway: 4096, // железнодорожный переезд
  oncoming: 8192, // выезд на встречную
};

// Ключевые слова из официальных перечней Госавтоинспекции.
const RULES = [
  [FEATURE.speed, /превышени\S* скорост|скоростн\S* режим/i],
  [FEATURE.avgSpeed, /средн\S* скорост/i],
  [FEATURE.redLight, /запрещающ\S* сигнал|красн\S* сигнал|проезд на запрещ/i],
  [FEATURE.stopLine, /стоп-лини/i],
  [FEATURE.busLane, /маршрутн\S* (тс|транспорт|средств)|выделенн\S* полос/i],
  [FEATURE.marking, /разметк|сплошн\S* лини|островк/i],
  [FEATURE.pedestrian, /пешеход/i],
  [FEATURE.seatbelt, /ремн\S* безопасност|телефон/i],
  [FEATURE.stopping, /остановк|стоянк/i],
  [FEATURE.turn, /поворот|разворот|требовани\S* знак|движение прямо|крайнего положения/i],
  [FEATURE.shoulder, /обочин/i],
  [FEATURE.truck, /грузов|габарит|весов/i],
  [FEATURE.railway, /переезд/i],
  [FEATURE.oncoming, /встречн\S* полос|выезд на полосу.*встречн|сторону дороги, предназначенную для встречного/i],
  // Некоторые регионы пишут не словами, а номерами пунктов ПДД и дорожных знаков.
  [FEATURE.speed, /знак\S*\s*3\.24|п\.\s*10\.[1-4]\b/i],
  [FEATURE.redLight, /п\.\s*6\.[23]\b/i],
  [FEATURE.stopLine, /п\.\s*6\.13\b/i],
  [FEATURE.busLane, /п\.\s*18\.2\b/i],
  [FEATURE.seatbelt, /п\.\s*2\.1\.2\b|п\.\s*2\.7\b/i],
  [FEATURE.oncoming, /п\.\s*9\.1\(1\)|п\.\s*11\.4\b/i],
  [FEATURE.shoulder, /п\.\s*9\.9\b/i],
  [FEATURE.stopping, /п\.\s*12\.[1-4]\b/i],
  [FEATURE.pedestrian, /п\.\s*14\.[1-3]\b/i],
  [FEATURE.turn, /п\.\s*8\.[5-7]\b/i],
  [FEATURE.railway, /п\.\s*15\.\d/i],
];

export function featuresFromText(text) {
  return RULES.reduce((mask, [bit, re]) => (re.test(text) ? mask | bit : mask), 0);
}

// Теги OpenStreetMap: enforcement=* у камер и связей type=enforcement.
const OSM_ENFORCEMENT = {
  maxspeed: FEATURE.speed,
  mindistance: FEATURE.speed,
  average_speed: FEATURE.avgSpeed,
  traffic_signals: FEATURE.redLight,
  check: 0,
  lane: FEATURE.busLane,
  noparking: FEATURE.stopping,
  parking: FEATURE.stopping,
  seatbelt: FEATURE.seatbelt,
  mobile_phone: FEATURE.seatbelt,
  level_crossing: FEATURE.railway,
  maxweight: FEATURE.truck,
  maxheight: FEATURE.truck,
};

export function featuresFromOsm(enforcement) {
  return String(enforcement ?? '')
    .split(';')
    .reduce((mask, value) => mask | (OSM_ENFORCEMENT[value.trim()] ?? 0), 0);
}
