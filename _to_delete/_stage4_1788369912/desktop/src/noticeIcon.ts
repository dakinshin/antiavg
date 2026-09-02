/**
 * Иконки для системных уведомлений.
 *
 * Рисуются в памяти, как и иконки трея: скруглённый квадрат цвета «тона» плюс
 * белый знак поверх. Цвет отвечает на вопрос «это хорошо или плохо», знак — на
 * вопрос «что произошло». Уведомление читают краем глаза, и до текста дело
 * доходит не всегда.
 *
 * ВАЖНО про платформы: собственную иконку уведомления показывают Windows и
 * Linux. macOS её игнорирует и всегда рисует иконку приложения — ограничение
 * системы, а не наша недоработка (electron/electron#1025). Код на macOS
 * отработает без ошибок, просто иконка будет обычной.
 */
import { nativeImage, type NativeImage } from 'electron';

/** Что произошло с точки зрения человека. */
export type NoticeTone =
  /** Всё в порядке: ограничение соблюдено, блокировка снята. */
  | 'good'
  /** Программа вмешалась штатно — это надо просто учесть. */
  | 'neutral'
  /** Тревога: риск не ограничен, позиция закрыта, сорвалась серия стопов. */
  | 'bad';

export type NoticeGlyph =
  /** Галка — порядок. */
  | 'check'
  /** Восклицательный знак — тревога. */
  | 'alert'
  /** Крест — позиция закрыта принудительно. */
  | 'close'
  /** Минус — объём срезан. */
  | 'cut'
  /** Пауза — торговля заблокирована. */
  | 'pause'
  /** «i» — к сведению. */
  | 'info';

export interface NoticeIcon {
  tone: NoticeTone;
  glyph: NoticeGlyph;
}

/** Те же цвета, что у индикатора в трее и в окне: одна палитра на всё. */
const TONES: Record<NoticeTone, [number, number, number]> = {
  good: [0x0c, 0xa3, 0x0c], // зелёный
  neutral: [0x39, 0x87, 0xe5], // синий
  bad: [0xd0, 0x3b, 0x3b], // красный
};

/** 96 пикселей при scaleFactor 2 — это 48 логических, размер плитки в тосте. */
const SIZE = 96;

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
interface Dot {
  x: number;
  y: number;
  r: number;
}

/** Знаки заданы в долях иконки: отрезки с круглыми концами плюс точки. */
const GLYPHS: Record<NoticeGlyph, { segments: Segment[]; dots: Dot[] }> = {
  check: {
    segments: [
      { x1: 0.28, y1: 0.52, x2: 0.44, y2: 0.68 },
      { x1: 0.44, y1: 0.68, x2: 0.73, y2: 0.33 },
    ],
    dots: [],
  },
  alert: {
    segments: [{ x1: 0.5, y1: 0.25, x2: 0.5, y2: 0.56 }],
    dots: [{ x: 0.5, y: 0.72, r: 0.062 }],
  },
  close: {
    segments: [
      { x1: 0.32, y1: 0.32, x2: 0.68, y2: 0.68 },
      { x1: 0.68, y1: 0.32, x2: 0.32, y2: 0.68 },
    ],
    dots: [],
  },
  cut: {
    segments: [{ x1: 0.29, y1: 0.5, x2: 0.71, y2: 0.5 }],
    dots: [],
  },
  pause: {
    segments: [
      { x1: 0.4, y1: 0.29, x2: 0.4, y2: 0.71 },
      { x1: 0.6, y1: 0.29, x2: 0.6, y2: 0.71 },
    ],
    dots: [],
  },
  info: {
    segments: [{ x1: 0.5, y1: 0.45, x2: 0.5, y2: 0.73 }],
    dots: [{ x: 0.5, y: 0.28, r: 0.062 }],
  },
};

/** Половина толщины линии знака, в долях иконки. */
const STROKE = 0.055;

function distanceToSegment(px: number, py: number, s: Segment): number {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - s.x1) * dx + (py - s.y1) * dy) / len2)) : 0;
  return Math.hypot(px - (s.x1 + t * dx), py - (s.y1 + t * dy));
}

/**
 * Знаковое расстояние до скруглённого квадрата: внутри отрицательное.
 * Отсюда берётся мягкий край без ступенек.
 */
function distanceToRoundedRect(px: number, py: number, half: number, radius: number): number {
  const qx = Math.abs(px - 0.5) - (half - radius);
  const qy = Math.abs(py - 0.5) - (half - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Покрытие пикселя фигурой: сглаживание на ширину одного пикселя. */
function coverage(distance: number, px: number): number {
  return Math.max(0, Math.min(1, 0.5 - distance / px));
}

function draw(glyph: NoticeGlyph, tone: NoticeTone): Buffer {
  const buf = Buffer.alloc(SIZE * SIZE * 4);
  const [r, g, b] = TONES[tone];
  const shape = GLYPHS[glyph];
  const px = 1 / SIZE;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // Центр пикселя в долях иконки.
      const u = (x + 0.5) / SIZE;
      const v = (y + 0.5) / SIZE;

      const bg = coverage(distanceToRoundedRect(u, v, 0.47, 0.14), px);
      if (bg <= 0) continue;

      let mark = 0;
      for (const s of shape.segments) {
        mark = Math.max(mark, coverage(distanceToSegment(u, v, s) - STROKE, px));
      }
      for (const d of shape.dots) {
        mark = Math.max(mark, coverage(Math.hypot(u - d.x, v - d.y) - d.r, px));
      }

      // Знак — белый поверх цвета фона; прозрачность берётся от фона, чтобы
      // знак не «выпадал» за скруглённый край.
      const cr = r + (255 - r) * mark;
      const cg = g + (255 - g) * mark;
      const cb = b + (255 - b) * mark;

      const i = (y * SIZE + x) * 4;
      const a = Math.round(bg * 255);
      // BGRA с премультиплицированной альфой — как ждёт createFromBitmap.
      buf[i] = Math.round((cb * a) / 255);
      buf[i + 1] = Math.round((cg * a) / 255);
      buf[i + 2] = Math.round((cr * a) / 255);
      buf[i + 3] = a;
    }
  }
  return buf;
}

const cache = new Map<string, NativeImage>();

export function noticeIcon(icon: NoticeIcon): NativeImage {
  const key = `${icon.glyph}|${icon.tone}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const img = nativeImage.createFromBitmap(draw(icon.glyph, icon.tone), {
    width: SIZE,
    height: SIZE,
    scaleFactor: 2,
  });
  cache.set(key, img);
  return img;
}
