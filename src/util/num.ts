/**
 * Числовые помощники. Все количества/цены отправляются на биржу строкой,
 * округлённой по stepSize/tickSize, поэтому важно не потерять точность при
 * округлении и не получить экспоненциальную запись.
 */

const EPS = 1e-12;

/** Количество знаков после запятой у шага (0.001 -> 3, 1 -> 0). */
export function stepDecimals(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const s = step.toExponential(15);
  const [mantissa, expPart] = s.split('e');
  const exp = Number(expPart);
  const mantissaDecimals = (mantissa ?? '').replace('-', '').split('.')[1]?.replace(/0+$/, '').length ?? 0;
  return Math.max(0, mantissaDecimals - exp);
}

/** Округление вниз до кратного шагу. Используется для количеств. */
export function floorToStep(value: number, step: number): number {
  if (!Number.isFinite(step) || step <= 0) return value;
  const d = stepDecimals(step);
  const scale = Math.pow(10, d);
  const scaledStep = Math.round(step * scale);
  const scaledValue = Math.floor(value * scale + 1e-6);
  const result = Math.floor(scaledValue / scaledStep) * scaledStep;
  return result / scale;
}

/** Округление к ближайшему кратному шагу. Используется для цен. */
export function roundToStep(value: number, step: number): number {
  if (!Number.isFinite(step) || step <= 0) return value;
  const d = stepDecimals(step);
  const scale = Math.pow(10, d);
  const scaledStep = Math.round(step * scale);
  const scaledValue = Math.round(value * scale);
  const result = Math.round(scaledValue / scaledStep) * scaledStep;
  return result / scale;
}

/** Строковое представление без экспоненты, с фиксированным числом знаков шага. */
export function formatByStep(value: number, step: number): string {
  const d = stepDecimals(step);
  return value.toFixed(d);
}

export function isZero(value: number, eps = EPS): boolean {
  return Math.abs(value) <= eps;
}

export function sameSign(a: number, b: number, eps = EPS): boolean {
  if (Math.abs(a) <= eps || Math.abs(b) <= eps) return false;
  return a > 0 === b > 0;
}

export function nearlyEqual(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
}

export function toNum(value: string | number | undefined | null, fallback = 0): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Короткое представление для логов: убирает хвосты плавающей точки. */
export function round8(value: number): number {
  if (!Number.isFinite(value)) return value;
  return Number(value.toFixed(8));
}
