/**
 * Иконки трея рисуются в памяти, без файлов-ресурсов.
 *
 * `nativeImage.createFromBitmap` принимает сырой BGRA-буфер, поэтому достаточно
 * посчитать круг нужного цвета с мягким краем. Так иконка всегда соответствует
 * состоянию и не зависит от того, что положили в сборку.
 */
import { nativeImage, type NativeImage } from 'electron';

export type GuardState = 'stopped' | 'connecting' | 'live' | 'dry' | 'alarm' | 'error';

/** Цвета согласованы со статусной палитрой окна. */
const COLORS: Record<GuardState, [number, number, number]> = {
  stopped: [0x89, 0x87, 0x81], // серый
  connecting: [0xfa, 0xb2, 0x19], // жёлтый
  live: [0x0c, 0xa3, 0x0c], // зелёный
  dry: [0x39, 0x87, 0xe5], // синий
  alarm: [0xd0, 0x3b, 0x3b], // красный
  error: [0xec, 0x83, 0x5a], // оранжевый
};

const SIZE = 32;

function drawCircle(r: number, g: number, b: number, ring: boolean): Buffer {
  const buf = Buffer.alloc(SIZE * SIZE * 4);
  const c = (SIZE - 1) / 2;
  const outer = SIZE / 2 - 2;
  const inner = outer - 4.5;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const d = Math.hypot(x - c, y - c);
      // Сглаживание края: альфа спадает на полпикселя.
      let alpha = Math.max(0, Math.min(1, outer - d + 0.5));
      if (ring) {
        // Кольцо: вырезаем середину — состояние «работает вхолостую».
        const hole = Math.max(0, Math.min(1, d - inner + 0.5));
        alpha = Math.min(alpha, hole);
      }
      const i = (y * SIZE + x) * 4;
      const a = Math.round(alpha * 255);
      // BGRA, цвета премультиплицированы на альфу.
      buf[i] = Math.round((b * a) / 255);
      buf[i + 1] = Math.round((g * a) / 255);
      buf[i + 2] = Math.round((r * a) / 255);
      buf[i + 3] = a;
    }
  }
  return buf;
}

const cache = new Map<GuardState, NativeImage>();

export function trayIcon(state: GuardState): NativeImage {
  const cached = cache.get(state);
  if (cached) return cached;

  const [r, g, b] = COLORS[state];
  const img = nativeImage.createFromBitmap(drawCircle(r, g, b, state === 'dry'), {
    width: SIZE,
    height: SIZE,
    scaleFactor: 2,
  });
  cache.set(state, img);
  return img;
}

export function stateTitle(state: GuardState): string {
  switch (state) {
    case 'stopped':
      return 'Защита остановлена';
    case 'connecting':
      return 'Подключение к Binance…';
    case 'live':
      return 'Защита активна — боевой режим';
    case 'dry':
      return 'Защита активна — только наблюдение (dry run)';
    case 'alarm':
      return 'Сработала защита от усреднения';
    case 'error':
      return 'Проблема со связью';
  }
}
