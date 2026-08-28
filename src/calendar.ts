import type { Market, MarketPhase } from './model.js';

export type MarketClosures = Record<string, { CN: string[]; HK: string[] }>;

export type CalendarConfidence = 'configured' | 'degraded';

export type MarketSession = {
  phase: MarketPhase;
  calendarConfidence: CalendarConfidence;
  tradingDate: string;
  active: boolean;
};

export type MarketState = Record<Market, MarketSession>;

type ShanghaiDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: string;
};

type PhaseRange = {
  start: number;
  end: number;
  phase: Extract<MarketPhase, 'auction' | 'preopen' | 'continuous'>;
};

const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';
const FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: SHANGHAI_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
  hourCycle: 'h23',
});
const DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: SHANGHAI_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const PHASES: Record<Market, PhaseRange[]> = {
  CN: [
    { start: 9 * 60 + 15, end: 9 * 60 + 30, phase: 'auction' },
    { start: 9 * 60 + 30, end: 11 * 60 + 30, phase: 'continuous' },
    { start: 13 * 60, end: 15 * 60, phase: 'continuous' },
  ],
  HK: [
    { start: 9 * 60, end: 9 * 60 + 30, phase: 'preopen' },
    { start: 9 * 60 + 30, end: 12 * 60, phase: 'continuous' },
    { start: 13 * 60, end: 16 * 60, phase: 'continuous' },
  ],
};

const BOUNDARIES: Record<Market, number[]> = {
  CN: [9 * 60 + 15, 9 * 60 + 30, 11 * 60 + 30, 13 * 60, 15 * 60],
  HK: [9 * 60, 9 * 60 + 30, 12 * 60, 13 * 60, 16 * 60],
};

export function marketState(now: Date, closures: MarketClosures): MarketState {
  const parts = shanghaiParts(now);
  return {
    CN: sessionFor('CN', parts, closures),
    HK: sessionFor('HK', parts, closures),
  };
}

export function isActivePhase(phase: MarketPhase): boolean {
  return phase === 'auction' || phase === 'preopen' || phase === 'continuous';
}

export function shanghaiMinuteOfDay(now: Date): number {
  const parts = shanghaiParts(now);
  return parts.hour * 60 + parts.minute;
}

export function shanghaiDate(timestamp: string | Date): string {
  const values = Object.fromEntries(DATE_FORMATTER.formatToParts(typeof timestamp === 'string' ? new Date(timestamp) : timestamp)
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function isMarketTradingDate(tradingDate: string, market: Market, closures: MarketClosures): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(tradingDate);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const represented = new Date(`${tradingDate}T00:00:00Z`);
  if (
    represented.getUTCFullYear() !== year
    || represented.getUTCMonth() + 1 !== month
    || represented.getUTCDate() !== day
  ) return false;
  return isTradingDay({
    year,
    month,
    day,
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][represented.getUTCDay()]!,
  }, market, closures);
}

export function nextStateChange(now: Date, market: Market, closures: MarketClosures): Date {
  const parts = shanghaiParts(now);
  if (isTradingDay(parts, market, closures)) {
    for (const minute of BOUNDARIES[market]) {
      const candidate = atShanghaiMinute(parts.year, parts.month, parts.day, minute);
      if (candidate.getTime() > now.getTime()) return candidate;
    }
  }

  const next = nextTradingDate(parts, market, closures);
  return atShanghaiMinute(next.year, next.month, next.day, PHASES[market][0]!.start);
}

export function lastClosedTradingDate(now: Date, market: Market, closures: MarketClosures): string {
  const parts = shanghaiParts(now);
  const closeMinute = BOUNDARIES[market][BOUNDARIES[market].length - 1]!;
  if (isTradingDay(parts, market, closures) && parts.hour * 60 + parts.minute >= closeMinute) {
    return dateKey(parts.year, parts.month, parts.day);
  }
  const previous = previousTradingDate(parts, market, closures);
  return dateKey(previous.year, previous.month, previous.day);
}

function sessionFor(market: Market, parts: ShanghaiDateParts, closures: MarketClosures): MarketSession {
  const tradingDate = dateKey(parts.year, parts.month, parts.day);
  const calendarConfidence: CalendarConfidence = Object.hasOwn(closures, String(parts.year)) ? 'configured' : 'degraded';
  if (!isTradingDay(parts, market, closures)) {
    return { phase: 'closed', calendarConfidence, tradingDate, active: false };
  }

  const minute = parts.hour * 60 + parts.minute;
  const activeRange = PHASES[market].find((range) => minute >= range.start && minute < range.end);
  if (activeRange) {
    return { phase: activeRange.phase, calendarConfidence, tradingDate, active: true };
  }

  const lunchStart = PHASES[market][1]!.end;
  const lunchEnd = PHASES[market][2]!.start;
  const phase: MarketPhase = minute >= lunchStart && minute < lunchEnd ? 'lunch' : 'closed';
  return { phase, calendarConfidence, tradingDate, active: false };
}

function nextTradingDate(parts: ShanghaiDateParts, market: Market, closures: MarketClosures): Pick<ShanghaiDateParts, 'year' | 'month' | 'day'> {
  const cursor = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  for (let offset = 1; offset <= 370; offset++) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const candidate = {
      year: cursor.getUTCFullYear(),
      month: cursor.getUTCMonth() + 1,
      day: cursor.getUTCDate(),
      hour: 0,
      minute: 0,
      weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][cursor.getUTCDay()]!,
    };
    if (isTradingDay(candidate, market, closures)) return candidate;
  }
  throw new Error(`No ${market} trading day found within one year`);
}

function previousTradingDate(parts: ShanghaiDateParts, market: Market, closures: MarketClosures): Pick<ShanghaiDateParts, 'year' | 'month' | 'day'> {
  const cursor = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  for (let offset = 1; offset <= 370; offset++) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const candidate = {
      year: cursor.getUTCFullYear(),
      month: cursor.getUTCMonth() + 1,
      day: cursor.getUTCDate(),
      hour: 0,
      minute: 0,
      weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][cursor.getUTCDay()]!,
    };
    if (isTradingDay(candidate, market, closures)) return candidate;
  }
  throw new Error(`No prior ${market} trading day found within one year`);
}

function isTradingDay(parts: Pick<ShanghaiDateParts, 'year' | 'month' | 'day' | 'weekday'>, market: Market, closures: MarketClosures): boolean {
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
  return !closures[String(parts.year)]?.[market].includes(dateKey(parts.year, parts.month, parts.day));
}

function shanghaiParts(now: Date): ShanghaiDateParts {
  const values = Object.fromEntries(FORMATTER.formatToParts(now)
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    weekday: values.weekday!,
  };
}

function atShanghaiMinute(year: number, month: number, day: number, minute: number): Date {
  const wallTime = Date.UTC(year, month - 1, day, Math.floor(minute / 60), minute % 60);
  let candidate = new Date(wallTime);
  for (let attempts = 0; attempts < 3; attempts++) {
    const parts = shanghaiParts(candidate);
    const observedWallTime = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const adjustment = wallTime - observedWallTime;
    if (adjustment === 0) return candidate;
    candidate = new Date(candidate.getTime() + adjustment);
  }
  return candidate;
}

function dateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
