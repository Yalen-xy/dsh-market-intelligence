import assert from 'node:assert/strict';
import { test } from 'node:test';
import { marketState, nextStateChange } from '../src/calendar.ts';
import { atShanghai } from './helpers.ts';

test('calculates CN auction, lunch, and HK afternoon independently', () => {
  assert.equal(marketState(atShanghai('2026-08-27 09:20'), {}).CN.phase, 'auction');
  assert.equal(marketState(atShanghai('2026-08-27 11:45'), {}).CN.phase, 'lunch');
  assert.equal(marketState(atShanghai('2026-08-27 15:30'), {}).HK.phase, 'continuous');
});

test('uses exact Shanghai phase boundaries and closes markets at weekends', () => {
  assert.equal(marketState(atShanghai('2026-08-27 09:00'), {}).HK.phase, 'preopen');
  assert.equal(marketState(atShanghai('2026-08-27 09:00'), {}).CN.phase, 'closed');
  assert.equal(marketState(atShanghai('2026-08-27 09:30'), {}).CN.phase, 'continuous');
  assert.equal(marketState(atShanghai('2026-08-27 11:30'), {}).CN.phase, 'lunch');
  assert.equal(marketState(atShanghai('2026-08-27 12:00'), {}).HK.phase, 'lunch');
  assert.equal(marketState(atShanghai('2026-08-29 10:00'), {}).HK.phase, 'closed');
});

test('uses every relevant CN and HK phase boundary exactly', () => {
  const phase = (time: string, market: 'CN' | 'HK') => marketState(atShanghai(`2026-08-27 ${time}`), {})[market].phase;
  assert.equal(phase('09:14', 'CN'), 'closed');
  assert.equal(phase('09:15', 'CN'), 'auction');
  assert.equal(phase('09:30', 'CN'), 'continuous');
  assert.equal(phase('11:30', 'CN'), 'lunch');
  assert.equal(phase('13:00', 'CN'), 'continuous');
  assert.equal(phase('15:00', 'CN'), 'closed');
  assert.equal(phase('08:59', 'HK'), 'closed');
  assert.equal(phase('09:00', 'HK'), 'preopen');
  assert.equal(phase('09:30', 'HK'), 'continuous');
  assert.equal(phase('12:00', 'HK'), 'lunch');
  assert.equal(phase('13:00', 'HK'), 'continuous');
  assert.equal(phase('16:00', 'HK'), 'closed');
});

test('uses the Shanghai timezone database for historical daylight-saving boundaries', () => {
  const beforeHongKongPreopen = new Date('1991-08-23T08:59:00+09:00');
  assert.equal(marketState(new Date('1991-08-23T09:00:00+09:00'), {}).HK.phase, 'preopen');
  assert.equal(nextStateChange(beforeHongKongPreopen, 'HK', {}).toISOString(), '1991-08-23T00:00:00.000Z');
});

test('configured closure stops polling and missing year degrades confidence', () => {
  const closed = marketState(atShanghai('2026-10-01 10:00'), { '2026': { CN: ['2026-10-01'], HK: [] } });
  assert.equal(closed.CN.phase, 'closed');
  assert.equal(closed.CN.calendarConfidence, 'configured');
  assert.equal(marketState(atShanghai('2027-01-04 10:00'), {}).CN.calendarConfidence, 'degraded');
});

test('an explicit empty year is configured and preserves weekday phase correctness', () => {
  const state = marketState(atShanghai('2026-08-27 10:00'), { '2026': { CN: [], HK: [] } });
  assert.equal(state.CN.calendarConfidence, 'configured');
  assert.equal(state.CN.phase, 'continuous');
  assert.equal(state.HK.calendarConfidence, 'configured');
  assert.equal(state.HK.phase, 'continuous');
});
