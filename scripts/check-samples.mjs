import fs from 'node:fs';
import path from 'node:path';
import Papa from 'papaparse';
import Encoding from 'encoding-japanese';
import dayjs from 'dayjs';
import customParse from 'dayjs/plugin/customParseFormat.js';

dayjs.extend(customParse);

const DATE_FORMATS = ['YYYY/MM/DD', 'YYYY-MM-DD', 'YYYY.MM.DD', 'YYYYMMDD'];
const TIME_FORMATS = ['HH:mm:ss.SSS', 'HH:mm:ss.SS', 'HH:mm:ss.S', 'HH:mm:ss', 'HH:mm', 'HHmmss', 'HHmm'];

const normalizeString = (v) => {
  if (v == null) return '';
  if (v instanceof Date) return dayjs(v).format('YYYY/MM/DD HH:mm:ss.SSS');
  return String(v).trim().replace(/^'+/, '');
};

const parseDateCell = (v) => {
  if (v instanceof Date) return dayjs(v);
  if (typeof v === 'number') return dayjs(new Date(v));
  const s = normalizeString(v);
  if (!s) return null;
  for (const f of DATE_FORMATS) {
    const d = dayjs(s, f, true);
    if (d.isValid()) return d;
  }
  const d = dayjs(s);
  return d.isValid() ? d : null;
};

const parseTimeCell = (v) => {
  if (v instanceof Date) return { h: v.getHours(), m: v.getMinutes(), s: v.getSeconds(), ms: v.getMilliseconds() };
  if (typeof v === 'number') {
    const date = new Date(v);
    return { h: date.getHours(), m: date.getMinutes(), s: date.getSeconds(), ms: date.getMilliseconds() };
  }
  const s = normalizeString(v);
  if (!s) return { h: 0, m: 0, s: 0, ms: 0 };
  for (const f of TIME_FORMATS) {
    const t = dayjs(s, f, true);
    if (t.isValid()) return { h: t.hour(), m: t.minute(), s: t.second(), ms: t.millisecond() };
  }
  const t = dayjs(`1970-01-01T${s}`);
  return t.isValid() ? { h: t.hour(), m: t.minute(), s: t.second(), ms: t.millisecond() } : { h: 0, m: 0, s: 0, ms: 0 };
};

const composeTimestamp = (a, b) => {
  const d1 = parseDateCell(a);
  const t2 = parseTimeCell(b);
  if (d1) {
    const t = t2 ?? parseTimeCell(a) ?? { h: 0, m: 0, s: 0, ms: 0 };
    return d1.hour(t.h).minute(t.m).second(t.s).millisecond(t.ms).toDate();
  }
  const d2 = parseDateCell(b);
  if (d2) {
    const t = parseTimeCell(a);
    if (t) return d2.hour(t.h).minute(t.m).second(t.s).millisecond(t.ms).toDate();
    return d2.toDate();
  }
  return null;
};

const decodeCsvContent = (filepath) => {
  const buf = fs.readFileSync(filepath);
  let text = '';
  try { text = new TextDecoder('utf-8', { fatal: false }).decode(buf); } catch {}
  if (!text || text.includes('\uFFFD')) {
    try {
      const view = new Uint8Array(buf);
      const det = Encoding.detect(view);
      text = Encoding.convert(view, { to: 'UNICODE', from: det ?? undefined, type: 'string' });
    } catch {
      try { text = new TextDecoder('shift_jis').decode(buf); } catch {}
    }
  }
  return text;
};

const parseCsvPath = (filepath) => {
  const text = decodeCsvContent(filepath);
  const result = Papa.parse(text, { skipEmptyLines: 'greedy' });
  if (result.errors?.length) throw new Error(result.errors[0].message);
  const rows = result.data;
  const countNonEmpty = (row = []) =>
    row.reduce((count, cell) => count + (((cell ?? '').toString().trim().length > 0) ? 1 : 0), 0);
  // header detection (need at least date/time + 1 series name)
  const headerIndex = rows.findIndex((r) => Array.isArray(r) && countNonEmpty(r) >= 3);
  if (headerIndex < 0) throw new Error('ヘッダー行が見つかりませんでした');
  const headers = rows[headerIndex];
  const dataRows = rows.slice(headerIndex + 1);
  const timestamps = [];
  for (const r of dataRows) {
    const ts = composeTimestamp(r[0], r[1]);
    if (ts) timestamps.push(ts);
  }
  return { headers, rows: dataRows, timestamps };
};

const main = () => {
  const base = path.resolve('samples');
  const a = path.join(base, '20251024143432CH1_0.csv');
  const b = path.join(base, '20251024143432CH2_0.csv');
  const pa = parseCsvPath(a);
  const pb = parseCsvPath(b);
  console.log('[A] headers:', pa.headers.slice(0,5).join(','));
  console.log('[A] rows:', pa.rows.length, 'timestamps:', pa.timestamps.length, 'first:', pa.timestamps[0]);
  console.log('[B] headers:', pb.headers.slice(0,5).join(','));
  console.log('[B] rows:', pb.rows.length, 'timestamps:', pb.timestamps.length, 'first:', pb.timestamps[0]);
};

main();
