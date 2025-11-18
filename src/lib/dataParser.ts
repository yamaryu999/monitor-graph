import Papa from 'papaparse';
import Encoding from 'encoding-japanese';
import * as XLSX from 'xlsx';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';

dayjs.extend(customParseFormat);

export type CellValue = string | number | Date | null | undefined;
export type DataRow = CellValue[];

export type ParsedData = {
  timestamps: Date[];
  series: Record<string, (number | null)[]>;
};

export type ParsedDataset = {
  data: ParsedData;
  fileName: string;
  label: string;
};

type TimeParts = {
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
};

const DATE_FORMATS = ['YYYY/MM/DD', 'YYYY-MM-DD', 'YYYY.MM.DD', 'YYYYMMDD'];
const defaultTime: TimeParts = { hour: 0, minute: 0, second: 0, millisecond: 0 };

const sanitizeRows = (rows: DataRow[]): DataRow[] =>
  rows.filter((row) => Array.isArray(row) && row.some((cell) => (cell ?? '').toString().trim().length > 0));

const countNonEmptyCells = (row: DataRow): number =>
  row.reduce<number>((count, cell) => count + ((cell ?? '').toString().trim().length > 0 ? 1 : 0), 0);

const toNumeric = (value: CellValue): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return Number.isFinite(value.valueOf()) ? value.valueOf() : null;
  const trimmed = value.toString().trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseExcelDate = (value: number): dayjs.Dayjs | null => {
  const parsed = XLSX.SSF.parse_date_code(value);
  if (!parsed) return null;
  return dayjs(new Date(parsed.y, parsed.m - 1, parsed.d));
};

const createDayjsFromParts = (year: number, month: number, day: number): dayjs.Dayjs | null => {
  if (![year, month, day].every((v) => Number.isFinite(v))) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const candidate = dayjs(new Date(year, month - 1, day));
  return candidate.isValid() ? candidate : null;
};

const parseDateStringFast = (value: string): dayjs.Dayjs | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const delimiter = trimmed.includes('/') ? '/' : trimmed.includes('-') ? '-' : trimmed.includes('.') ? '.' : null;
  if (delimiter) {
    const segments = trimmed.split(delimiter);
    if (segments.length === 3) {
      const [yearStr, monthStr, dayStr] = segments;
      const year = Number(yearStr);
      const month = Number(monthStr);
      const day = Number(dayStr);
      const candidate = createDayjsFromParts(year, month, day);
      if (candidate) return candidate;
    }
  } else if (/^\d{8}$/.test(trimmed)) {
    const year = Number(trimmed.slice(0, 4));
    const month = Number(trimmed.slice(4, 6));
    const day = Number(trimmed.slice(6, 8));
    const candidate = createDayjsFromParts(year, month, day);
    if (candidate) return candidate;
  }

  return null;
};

const parseDateCell = (value: CellValue): dayjs.Dayjs | null => {
  if (value instanceof Date) return dayjs(value);
  if (typeof value === 'number') return parseExcelDate(value);

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    const fast = parseDateStringFast(trimmed);
    if (fast) return fast;

    for (const format of DATE_FORMATS) {
      const candidate = dayjs(trimmed, format, true);
      if (candidate.isValid()) return candidate;
    }

    const fallback = dayjs(trimmed);
    if (fallback.isValid()) return fallback;
  }

  return null;
};

const normalizeExcelString = (input: string): string => input.replace(/^['＇‘’"＂]+/, '').trim();

const createTimeParts = (hour: number, minute: number, second = 0, millisecond = 0): TimeParts | null => {
  if (![hour, minute, second, millisecond].every((v) => Number.isFinite(v))) return null;
  if (hour < 0 || hour > 99) return null;
  if (minute < 0 || minute > 59) return null;
  if (second < 0 || second > 59) return null;
  if (millisecond < 0 || millisecond > 999) return null;
  return { hour, minute, second, millisecond };
};

const parseSecondsComponent = (value: string): { second: number; millisecond: number } | null => {
  const trimmed = value.trim();
  if (!trimmed) return { second: 0, millisecond: 0 };
  if (trimmed.includes('.')) {
    const [secStr, fraction = ''] = trimmed.split('.');
    const second = Number(secStr);
    if (!Number.isFinite(second)) return null;
    const fractionValue = Number(`0.${fraction}`);
    if (!Number.isFinite(fractionValue)) return null;
    return { second, millisecond: Math.min(999, Math.round(fractionValue * 1000)) };
  }
  const second = Number(trimmed);
  return Number.isFinite(second) ? { second, millisecond: 0 } : null;
};

const parseColonSeparatedTime = (value: string): TimeParts | null => {
  const segments = value.split(':');
  if (segments.length < 2 || segments.length > 3) return null;
  const [hourStr, minuteStr, secStr] = segments;
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;

  if (segments.length === 2) {
    return createTimeParts(hour, minute);
  }

  const seconds = parseSecondsComponent(secStr ?? '');
  if (!seconds) return null;
  return createTimeParts(hour, minute, seconds.second, seconds.millisecond);
};

const parseCompactTime = (value: string): TimeParts | null => {
  if (/^\d{6}$/.test(value)) {
    const hour = Number(value.slice(0, 2));
    const minute = Number(value.slice(2, 4));
    const second = Number(value.slice(4, 6));
    return createTimeParts(hour, minute, second, 0);
  }
  if (/^\d{4}$/.test(value)) {
    const hour = Number(value.slice(0, 2));
    const minute = Number(value.slice(2, 4));
    return createTimeParts(hour, minute, 0, 0);
  }
  return null;
};

const parseTimeStringFast = (value: string): TimeParts | null => {
  const normalized = normalizeExcelString(value);
  if (!normalized) return null;

  if (normalized.includes(':')) {
    const colonParsed = parseColonSeparatedTime(normalized);
    if (colonParsed) return colonParsed;
  }

  const compact = parseCompactTime(normalized);
  if (compact) return compact;

  return null;
};

const parseTimeCell = (value: CellValue): TimeParts | null => {
  if (value instanceof Date) {
    return {
      hour: value.getHours(),
      minute: value.getMinutes(),
      second: value.getSeconds(),
      millisecond: value.getMilliseconds()
    };
  }

  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) {
      return {
        hour: parsed.H ?? 0,
        minute: parsed.M ?? 0,
        second: parsed.S ?? 0,
        millisecond: Math.round(((parsed.u ?? 0) % 1) * 1000)
      };
    }
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const fast = parseTimeStringFast(trimmed);
    if (fast) return fast;

    const normalized = normalizeExcelString(trimmed);
    if (normalized) {
      const fallback = dayjs(`1970-01-01T${normalized}`);
      if (fallback.isValid()) {
        return {
          hour: fallback.hour(),
          minute: fallback.minute(),
          second: fallback.second(),
          millisecond: fallback.millisecond()
        };
      }
    }
  }

  return null;
};

const composeTimestamp = (primaryCell: CellValue, secondaryCell: CellValue): Date | null => {
  const primaryDate = parseDateCell(primaryCell);
  const secondaryTime = parseTimeCell(secondaryCell);

  if (primaryDate) {
    const timeParts = secondaryTime ?? parseTimeCell(primaryCell) ?? defaultTime;
    return primaryDate
      .hour(timeParts.hour)
      .minute(timeParts.minute)
      .second(timeParts.second)
      .millisecond(timeParts.millisecond)
      .toDate();
  }

  const secondaryDate = parseDateCell(secondaryCell);
  if (secondaryDate) {
    const firstTime = parseTimeCell(primaryCell);
    if (firstTime) {
      return secondaryDate
        .hour(firstTime.hour)
        .minute(firstTime.minute)
        .second(firstTime.second)
        .millisecond(firstTime.millisecond)
        .toDate();
    }
    return secondaryDate.toDate();
  }

  return null;
};

const buildParsedData = (rows: DataRow[]): ParsedData => {
  const meaningfulRows = sanitizeRows(rows);
  const headerIndex = meaningfulRows.findIndex((row) => countNonEmptyCells(row) >= 3);
  if (headerIndex === -1) {
    throw new Error('ヘッダー行が見つかりませんでした。');
  }

  const headers = meaningfulRows[headerIndex].map((cell) => (cell ?? '').toString().trim());
  if (headers.length < 3) {
    throw new Error('最低でも日付、時刻、1つ以上のデータ列が必要です。');
  }

  const dataKeys = headers.slice(2);
  const normalizedKeys = dataKeys.map((key, index) => {
    const trimmed = (key ?? '').toString().trim();
    return trimmed || `データ${index + 1}`;
  });

  const series: Record<string, (number | null)[]> = {};
  normalizedKeys.forEach((key) => {
    series[key] = [];
  });

  const timestamps: Date[] = [];

  const dataRows = meaningfulRows.slice(headerIndex + 1);
  for (let i = 0; i < dataRows.length; i += 1) {
    const row = dataRows[i];
    const timestamp = composeTimestamp(row[0], row[1]);
    if (!timestamp) {
      continue;
    }

    timestamps.push(timestamp);
    normalizedKeys.forEach((label, index) => {
      const value = toNumeric(row[index + 2]);
      series[label].push(value);
    });
  }

  if (!timestamps.length) {
    throw new Error('有効なタイムスタンプが作成できませんでした。');
  }

  return { timestamps, series };
};

const decodeCsvBuffer = (buffer: ArrayBuffer): string => {
  const view = new Uint8Array(buffer);
  let text = '';
  try {
    text = new TextDecoder('utf-8', { fatal: false }).decode(view);
  } catch {}
  if (!text || text.includes('\uFFFD')) {
    try {
      const detected = Encoding.detect(view);
      text = Encoding.convert(view, { to: 'UNICODE', from: detected ?? undefined, type: 'string' }) as string;
    } catch {
      try {
        text = new TextDecoder('shift_jis').decode(view);
      } catch {}
    }
  }
  return text;
};

const parseCsvBuffer = async (buffer: ArrayBuffer): Promise<DataRow[]> => {
  const text = decodeCsvBuffer(buffer);
  return new Promise((resolve, reject) => {
    Papa.parse<string[]>(text, {
      skipEmptyLines: 'greedy',
      complete: (results) => {
        if (results.errors.length) {
          reject(new Error(results.errors[0].message));
          return;
        }
        resolve(results.data as DataRow[]);
      },
      error: (error) => reject(error)
    });
  });
};

const parseXlsxBuffer = (buffer: ArrayBuffer): DataRow[] => {
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, blankrows: false }) as DataRow[];
};

export type ParseFileInput = {
  name: string;
  buffer: ArrayBuffer;
  type?: string;
};

const detectFileKind = (file: ParseFileInput): 'csv' | 'xlsx' | 'xls' | null => {
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext === 'csv') return 'csv';
  if (ext === 'xlsx') return 'xlsx';
  if (ext === 'xls') return 'xls';
  if ((file.type ?? '').includes('csv')) return 'csv';
  if ((file.type ?? '').includes('spreadsheetml')) return 'xlsx';
  return null;
};

export const parseFileInput = async (file: ParseFileInput): Promise<ParsedDataset> => {
  const kind = detectFileKind(file);
  let rows: DataRow[];
  if (kind === 'csv') {
    rows = await parseCsvBuffer(file.buffer);
  } else if (kind === 'xlsx' || kind === 'xls') {
    rows = parseXlsxBuffer(file.buffer);
  } else {
    throw new Error(`${file.name} は対応していないファイル形式です。CSV または XLSX を選択してください。`);
  }

  const data = buildParsedData(rows);
  return { data, fileName: file.name, label: file.name };
};

export const parseFileInputs = async (files: ParseFileInput[]): Promise<ParsedDataset[]> => {
  const results: ParsedDataset[] = [];
  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop
    const parsed = await parseFileInput(file);
    results.push(parsed);
  }
  return results;
};
