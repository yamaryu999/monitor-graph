import { ChangeEvent, MouseEvent, useCallback, useMemo, useRef, useState } from 'react';
import Papa from 'papaparse';
import Encoding from 'encoding-japanese';
import { Line } from 'react-chartjs-2';
import type { ChartData, ChartOptions, Plugin, TooltipItem } from 'chart.js';
import {
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LineElement,
  LinearScale,
  PointElement,
  TimeScale,
  Tooltip
} from 'chart.js';
import zoomPlugin from 'chartjs-plugin-zoom';
import 'chartjs-adapter-date-fns';
import * as XLSX from 'xlsx';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import './App.css';
import pkg from '../package.json';

dayjs.extend(customParseFormat);

const hoverLinePlugin: Plugin<'line'> = {
  id: 'hoverLine',
  afterDatasetsDraw: (chart) => {
    const activeElements = chart.tooltip?.getActiveElements?.() ?? [];
    if (!activeElements.length) {
      return;
    }

    const { ctx, chartArea } = chart;
    if (!chartArea) {
      return;
    }

    const x = activeElements[0].element.x;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(79, 70, 229, 0.8)';
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.restore();
  }
};

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  TimeScale,
  Tooltip,
  Legend,
  Filler,
  zoomPlugin,
  hoverLinePlugin
);

type CellValue = string | number | Date | null | undefined;
type DataRow = CellValue[];

type ParsedData = {
  timestamps: Date[];
  series: Record<string, (number | null)[]>;
};

type ParsedDataset = {
  data: ParsedData;
  fileName: string;
  label: string;
};

const annotateDatasetLabels = (datasets: ParsedDataset[]): ParsedDataset[] => {
  const counts = new Map<string, number>();
  return datasets.map((d, i) => {
    const base = d.label || d.fileName || `ログ${i + 1}`;
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    return { ...d, label: n > 1 ? `${base} (${n})` : base };
  });
};

const mergeParsedDatasets = (datasets: ParsedDataset[]): ParsedData => {
  if (datasets.length === 0) throw new Error('解析結果がありません。');
  if (datasets.length === 1) return datasets[0].data;

  const tsMap = new Map<number, Date>();
  datasets.forEach(({ data }) => data.timestamps.forEach((t) => {
    const k = t.getTime();
    if (!tsMap.has(k)) tsMap.set(k, t);
  }));
  const times = Array.from(tsMap.keys()).sort((a, b) => a - b);
  const timestamps = times.map((k) => tsMap.get(k) ?? new Date(k));
  const unionIndex = new Map<number, number>();
  times.forEach((t, i) => unionIndex.set(t, i));

  const merged: Record<string, (number | null)[]> = {};
  datasets.forEach(({ data, label }) => {
    const idx = new Map<number, number>();
    data.timestamps.forEach((t, i) => idx.set(t.getTime(), i));
    Object.entries(data.series).forEach(([name, vals]) => {
      const key = `[${label}] ${name}`;
      const arr = new Array(timestamps.length).fill(null) as (number | null)[];
      idx.forEach((src, tk) => {
        const ui = unionIndex.get(tk);
        if (ui !== undefined) arr[ui] = vals[src] ?? null;
      });
      merged[key] = arr;
    });
  });
  return { timestamps, series: merged };
};

const AXIS_KEYS = ['y1', 'y2', 'y3'] as const;
type AxisKey = (typeof AXIS_KEYS)[number];

const AXIS_CONFIG: Record<
  AxisKey,
  { label: string; position: 'left' | 'right'; color: string; offset?: boolean; gridOnChart?: boolean }
> = {
  y1: { label: 'Y1 (左軸)', position: 'left', color: '#0f172a', gridOnChart: true },
  y2: { label: 'Y2 (右軸)', position: 'right', color: '#16a34a', gridOnChart: false },
  y3: { label: 'Y3 (右軸2)', position: 'right', color: '#2563eb', offset: true, gridOnChart: false }
};

const AXIS_OPTIONS = AXIS_KEYS.map((key) => ({
  key,
  label: AXIS_CONFIG[key].label
}));

type AxisRangeState = Record<AxisKey, { min: string; max: string }>;

const createAxisRangeState = (): AxisRangeState =>
  AXIS_KEYS.reduce((acc, key) => {
    acc[key] = { min: '', max: '' };
    return acc;
  }, {} as AxisRangeState);

type TimeParts = {
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
};

const DATE_FORMATS = ['YYYY/MM/DD', 'YYYY-MM-DD', 'YYYY.MM.DD', 'YYYYMMDD'];
const TIME_FORMATS = ['HH:mm:ss.SSS', 'HH:mm:ss', 'HH:mm', 'HHmmss', 'HHmm'];

const defaultTime: TimeParts = { hour: 0, minute: 0, second: 0, millisecond: 0 };

const colorFromIndex = (index: number) => {
  const hue = (index * 67) % 360;
  return {
    border: `hsl(${hue} 70% 45%)`,
    background: `hsla(${hue} 70% 45% / 0.25)`
  };
};

const extractUnit = (name: string): string | undefined => {
  const m = name.match(/\[(.+?)\]/);
  return m ? m[1].trim() : undefined;
};

const KEYWORD_GROUPS = [
  { id: 'temperature', label: '温度 / Temp', regex: /(温度|temp|heat|℃|°c)/i },
  { id: 'humidity', label: '湿度 / Humidity', regex: /(湿度|humidity|%)/i },
  { id: 'pressure', label: '圧力 / Pressure', regex: /(圧|pressure|mpa|kpa)/i },
  { id: 'valve', label: '弁開度 / Valve', regex: /(弁|valve|開度|pulse|duty)/i },
  { id: 'status', label: 'ステータス', regex: /(status|ステータス|状態)/i },
  { id: 'code', label: 'コード/警報', regex: /(code|警報|アラーム)/i }
];

const deriveSeriesGroup = (name: string) => {
  const unit = extractUnit(name);
  const baseName = name.replace(/\s*\[.+?\]\s*$/, '').trim();
  if (unit) {
    return { groupId: `unit:${unit}`, groupLabel: `単位: ${unit}`, unit, baseName: baseName || name };
  }
  for (const g of KEYWORD_GROUPS) {
    if (g.regex.test(name)) return { groupId: g.id, groupLabel: g.label, unit: undefined, baseName: baseName || name };
  }
  return { groupId: 'others', groupLabel: 'その他', unit: undefined, baseName: baseName || name };
};

const computeLastValue = (values: (number | null)[]): number | null => {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const v = values[i];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
};

const computeVariability = (values: (number | null)[]): number => {
  const arr = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (arr.length < 2) return 0;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const varc = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  return Math.sqrt(varc);
};

const parseSeriesName = (name: string) => {
  const m = name.match(/^\[(.+?)\]\s+(.*)$/);
  if (m) return { fileLabel: m[1], seriesName: m[2] || name };
  return { fileLabel: 'ログ1', seriesName: name };
};

const resolveColor = (color: any, dataIndex: number): string => {
  if (!color) return '#888';
  if (typeof color === 'string') return color;
  if (Array.isArray(color)) {
    const v = color[dataIndex % color.length];
    return typeof v === 'string' ? v : '#888';
  }
  return '#888';
};

const sanitizeRows = (rows: DataRow[]): DataRow[] =>
  rows.filter((row) =>
    Array.isArray(row) && row.some((cell) => (cell ?? '').toString().trim().length > 0)
  );

const toNumeric = (value: CellValue): number | null => {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (value instanceof Date) {
    return Number.isFinite(value.valueOf()) ? value.valueOf() : null;
  }

  const trimmed = value.toString().trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseExcelDate = (value: number): dayjs.Dayjs | null => {
  const parsed = XLSX.SSF.parse_date_code(value);
  if (!parsed) {
    return null;
  }
  return dayjs(new Date(parsed.y, parsed.m - 1, parsed.d));
};

const parseDateCell = (value: CellValue): dayjs.Dayjs | null => {
  if (value instanceof Date) {
    return dayjs(value);
  }

  if (typeof value === 'number') {
    return parseExcelDate(value);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    for (const format of DATE_FORMATS) {
      const candidate = dayjs(trimmed, format, true);
      if (candidate.isValid()) {
        return candidate;
      }
    }

    const fallback = dayjs(trimmed);
    if (fallback.isValid()) {
      return fallback;
    }
  }

  return null;
};

const parseTimeCell = (value: CellValue): TimeParts => {
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
      return defaultTime;
    }

    const formats = ['HH:mm:ss.SSS', 'HH:mm:ss.SS', 'HH:mm:ss.S', 'HH:mm:ss', 'HH:mm', 'HHmmss', 'HHmm'];
    for (const format of formats) {
      const candidate = dayjs(trimmed, format, true);
      if (candidate.isValid()) {
        return {
          hour: candidate.hour(),
          minute: candidate.minute(),
          second: candidate.second(),
          millisecond: candidate.millisecond()
        };
      }
    }

    const fallback = dayjs(`1970-01-01T${trimmed}`);
    if (fallback.isValid()) {
      return {
        hour: fallback.hour(),
        minute: fallback.minute(),
        second: fallback.second(),
        millisecond: fallback.millisecond()
      };
    }
  }

  return defaultTime;
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
  const headerIndex = meaningfulRows.findIndex((row) => row.length >= 3);
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

const decodeCsvContent = async (file: File): Promise<string> => {
  const buffer = await file.arrayBuffer();
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

const parseCsvFile = async (file: File): Promise<DataRow[]> => {
  const text = await decodeCsvContent(file);
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

const parseXlsxFile = async (file: File): Promise<DataRow[]> => {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, blankrows: false }) as DataRow[];
  return rows;
};

const useChartData = (
  parsed: ParsedData | null,
  seriesVisibility: Record<string, boolean>,
  seriesAxis: Record<string, AxisKey>
): ChartData<'line'> | null =>
  useMemo(() => {
    if (!parsed) {
      return null;
    }

    const datasetEntries = Object.entries(parsed.series);

    return {
      datasets: datasetEntries.map(([label, values], index) => {
        const colors = colorFromIndex(index);
        const isVisible = seriesVisibility[label] ?? true;
        const points = parsed.timestamps.map((timestamp, pointIndex) => ({
          x: timestamp.getTime(),
          y: values[pointIndex] ?? null
        }));
        return {
          type: 'line' as const,
          label,
          data: points,
          borderColor: colors.border,
          backgroundColor: colors.background,
          spanGaps: true,
          pointRadius: 2,
          tension: 0.2,
          hidden: !isVisible,
          yAxisID: seriesAxis[label] ?? 'y1'
        };
      })
    } satisfies ChartData<'line'>;
  }, [parsed, seriesAxis, seriesVisibility]);

function App() {
  const [parsedData, setParsedData] = useState<ParsedData | null>(null);
  const [seriesVisibility, setSeriesVisibility] = useState<Record<string, boolean>>({});
  const [seriesAxis, setSeriesAxis] = useState<Record<string, AxisKey>>({});
  const [axisRanges, setAxisRanges] = useState<AxisRangeState>(() => createAxisRangeState());
  const [controlsOpen, setControlsOpen] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [bulkAxis, setBulkAxis] = useState<AxisKey>('y1');
  const [showTooltip, setShowTooltip] = useState(true);
  const [loadedFiles, setLoadedFiles] = useState<{ fileName: string; label: string }[]>([]);
  const [fileName, setFileName] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [inputKey, setInputKey] = useState(Date.now());
  const appVersion = (pkg as { version?: string }).version ?? '0.0.0';
  const chartRef = useRef<ChartJS<'line'> | null>(null);
  const fullRef = useRef<ChartJS<'line'> | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [sortMode, setSortMode] = useState<'name' | 'latest' | 'variability'>('name');
  const [selected, setSelected] = useState<string[]>([]);
  const lastClickedIndex = useRef<number | null>(null);
  const [collapsedFiles, setCollapsedFiles] = useState<Record<string, boolean>>({});
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  const chartData = useChartData(parsedData, seriesVisibility, seriesAxis);

  const chartOptions = useMemo<ChartOptions<'line'>>(() => {
    const toNumber = (value: string | undefined) => {
      if (value === undefined || value.trim() === '') {
        return undefined;
      }
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    };

    const axisBounds = AXIS_KEYS.reduce((acc, key) => {
      acc[key] = {
        min: toNumber(axisRanges[key]?.min),
        max: toNumber(axisRanges[key]?.max)
      };
      return acc;
    }, {} as Record<AxisKey, { min?: number; max?: number }>);

    return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index' as const, intersect: false, axis: 'x' },
    plugins: {
      legend: {
        display: false
      },
      tooltip: {
        enabled: showTooltip,
        intersect: false,
        mode: 'index',
        displayColors: true,
        usePointStyle: true,
        callbacks: {
          title(items: TooltipItem<'line'>[]) {
            const value = items[0]?.parsed?.x as number | undefined;
            if (value === undefined || value === null) return '';
            return dayjs(value).format('YYYY/MM/DD HH:mm:ss');
          },
          label(context) {
            const label = context.dataset?.label ?? '';
            const dsIndex = context.datasetIndex ?? 0;
            if (!context.chart.isDatasetVisible(dsIndex)) return undefined;
            if (seriesVisibility[label] === false) return undefined;
            return `${label}: ${context.formattedValue}`;
          },
          labelColor(context) {
            const label = context.dataset?.label ?? '';
            const dsIndex = context.datasetIndex ?? 0;
            if (!context.chart.isDatasetVisible(dsIndex)) return undefined;
            if (seriesVisibility[label] === false) return undefined;
            const color = resolveColor(context.dataset?.borderColor, context.dataIndex ?? 0);
            return { borderColor: color, backgroundColor: color, borderWidth: 2 };
          }
        }
      },
      zoom: {
        pan: {
          enabled: true,
          mode: 'x',
          modifierKey: 'shift'
        },
        zoom: {
          mode: 'x',
          drag: {
            enabled: true,
            borderColor: 'rgba(79, 70, 229, 0.8)',
            borderWidth: 1,
            backgroundColor: 'rgba(79, 70, 229, 0.15)'
          },
          wheel: {
            enabled: true,
            modifierKey: 'ctrl'
          },
          pinch: {
            enabled: true
          }
        }
      }
    },
    scales: {
      x: {
        type: 'time' as const,
        time: {
          tooltipFormat: 'yyyy/MM/dd HH:mm:ss',
          displayFormats: {
            minute: 'HH:mm',
            hour: 'HH:mm',
            day: 'MM/dd'
          }
        }
      },
      y1: {
        type: 'linear' as const,
        display: true,
        position: AXIS_CONFIG.y1.position,
        beginAtZero: false,
        min: axisBounds.y1.min,
        max: axisBounds.y1.max,
        ticks: { color: AXIS_CONFIG.y1.color },
        title: { display: true, text: AXIS_CONFIG.y1.label },
        grid: {
          drawOnChartArea: AXIS_CONFIG.y1.gridOnChart ?? true
        }
      },
      y2: {
        type: 'linear' as const,
        display: true,
        position: AXIS_CONFIG.y2.position,
        beginAtZero: false,
        min: axisBounds.y2.min,
        max: axisBounds.y2.max,
        ticks: { color: AXIS_CONFIG.y2.color },
        title: { display: true, text: AXIS_CONFIG.y2.label },
        grid: {
          drawOnChartArea: AXIS_CONFIG.y2.gridOnChart ?? false
        }
      },
      y3: {
        type: 'linear' as const,
        display: true,
        position: AXIS_CONFIG.y3.position,
        beginAtZero: false,
        min: axisBounds.y3.min,
        max: axisBounds.y3.max,
        ticks: { color: AXIS_CONFIG.y3.color },
        title: { display: true, text: AXIS_CONFIG.y3.label },
        offset: AXIS_CONFIG.y3.offset,
        grid: {
          drawOnChartArea: AXIS_CONFIG.y3.gridOnChart ?? false
        }
      }
    }
  };
  }, [axisRanges, seriesVisibility, showTooltip]);

  const resetState = () => {
    setParsedData(null);
    setSeriesVisibility({});
    setSeriesAxis({});
    setAxisRanges(createAxisRangeState());
    setFileName('');
  };

  const initializeSeriesState = (series: Record<string, (number | null)[]>) => {
    const visibility: Record<string, boolean> = {};
    const axis: Record<string, AxisKey> = {};
    Object.keys(series).forEach((key) => {
      visibility[key] = true;
      axis[key] = 'y1';
    });
    setSeriesVisibility(visibility);
    setSeriesAxis(axis);
  };

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files).slice(0, 2) : [];
    if (!files.length) return;
    setIsLoading(true);
    setErrorMessage(null);
    setInputKey(Date.now());
    try {
      const datasets: ParsedDataset[] = [];
      for (const file of files) {
        const ext = file.name.split('.').pop()?.toLowerCase();
        let rows: DataRow[];
        if (ext === 'csv') rows = await parseCsvFile(file);
        else if (ext === 'xlsx' || ext === 'xls') rows = await parseXlsxFile(file);
        else throw new Error('CSV もしくは XLSX ファイルを選択してください。');
        const parsed = buildParsedData(rows);
        datasets.push({ data: parsed, fileName: file.name, label: file.name });
      }
      const labeled = annotateDatasetLabels(datasets);
      const merged = mergeParsedDatasets(labeled);
      setParsedData(merged);
      initializeSeriesState(merged.series);
      setFileName(labeled.map((d) => d.fileName).join(', '));
      setLoadedFiles(labeled.map(({ fileName, label }) => ({ fileName, label })));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'ファイルの読み込みに失敗しました。');
      resetState();
    } finally {
      setIsLoading(false);
    }
  };

  const toggleSeries = (name: string) => {
    setSeriesVisibility((current) => ({
      ...current,
      [name]: !(current[name] ?? true)
    }));
  };

  const updateAllVisibility = (value: boolean) => {
    setSeriesVisibility((current) => {
      const keys = parsedData ? Object.keys(parsedData.series) : Object.keys(current);
      const next: Record<string, boolean> = {};
      keys.forEach((key) => {
        next[key] = value;
      });
      return next;
    });
  };

  const selectAll = () => updateAllVisibility(true);

  const clearAll = () => updateAllVisibility(false);

  const handleAxisChange = (name: string, axisKey: AxisKey) => {
    setSeriesAxis((current) => ({
      ...current,
      [name]: axisKey
    }));
  };

  const handleAxisRangeChange = (axisKey: AxisKey, field: 'min' | 'max', value: string) => {
    setAxisRanges((current) => ({
      ...current,
      [axisKey]: {
        ...current[axisKey],
        [field]: value
      }
    }));
  };

  const handleResetZoom = useCallback(() => {
    chartRef.current?.resetZoom();
    fullRef.current?.resetZoom();
  }, []);

  const seriesEntries = parsedData ? Object.keys(parsedData.series) : [];
  const descriptors = useMemo(() => {
    if (!parsedData) return [] as Array<{
      name: string;
      fileLabel: string;
      seriesName: string;
      groupId: string;
      groupLabel: string;
      unit?: string;
      lastValue: number | null;
      variability: number;
    }>;
    return seriesEntries.map((name) => {
      const { fileLabel, seriesName } = parseSeriesName(name);
      const g = deriveSeriesGroup(seriesName);
      const values = parsedData.series[name] ?? [];
      return {
        name,
        fileLabel,
        seriesName,
        groupId: g.groupId,
        groupLabel: g.groupLabel,
        unit: g.unit,
        lastValue: computeLastValue(values),
        variability: computeVariability(values)
      };
    });
  }, [parsedData, seriesEntries]);

  const filteredDescriptors = useMemo(() => {
    if (!filterText) return descriptors;
    const q = filterText.toLowerCase();
    return descriptors.filter((d) => d.name.toLowerCase().includes(q));
  }, [descriptors, filterText]);

  const sortedDescriptors = useMemo(() => {
    const arr = [...filteredDescriptors];
    switch (sortMode) {
      case 'latest':
        arr.sort((a, b) => (b.lastValue ?? -Infinity) - (a.lastValue ?? -Infinity));
        break;
      case 'variability':
        arr.sort((a, b) => b.variability - a.variability);
        break;
      default:
        arr.sort((a, b) => a.name.localeCompare(b.name));
        break;
    }
    return arr;
  }, [filteredDescriptors, sortMode]);

  const grouped = useMemo(() => {
    const map = new Map<string, Map<string, { groupLabel: string; unit?: string; items: typeof sortedDescriptors }>>();
    sortedDescriptors.forEach((d) => {
      if (!map.has(d.fileLabel)) map.set(d.fileLabel, new Map());
      const gm = map.get(d.fileLabel)!;
      if (!gm.has(d.groupId)) gm.set(d.groupId, { groupLabel: d.groupLabel, unit: d.unit, items: [] as any });
      gm.get(d.groupId)!.items.push(d);
    });
    return map;
  }, [sortedDescriptors]);

  const allNames = useMemo(() => descriptors.map((d) => d.name), [descriptors]);
  const visibleCount = useMemo(
    () => allNames.filter((n) => seriesVisibility[n] ?? true).length,
    [allNames, seriesVisibility]
  );

  const setVisibilityForFiltered = (value: boolean) => {
    setSeriesVisibility((current) => {
      const next = { ...current } as Record<string, boolean>;
      sortedDescriptors.forEach(({ name }) => {
        next[name] = value;
      });
      return next;
    });
  };

  const applyAxisToFiltered = (axisKey: AxisKey) => {
    setSeriesAxis((current) => {
      const next = { ...current } as Record<string, AxisKey>;
      sortedDescriptors.forEach(({ name }) => {
        next[name] = axisKey;
      });
      return next;
    });
  };

  // Selection handling (Shift+Click)
  const toggleSelect = (name: string, index: number, e?: MouseEvent) => {
    const isShift = !!e?.shiftKey;
    setSelected((curr) => {
      if (isShift && lastClickedIndex.current !== null) {
        const start = Math.min(lastClickedIndex.current, index);
        const end = Math.max(lastClickedIndex.current, index);
        const range = sortedDescriptors.slice(start, end + 1).map((d) => d.name);
        const set = new Set(curr);
        range.forEach((n) => set.add(n));
        return Array.from(set);
      }
      const set = new Set(curr);
      if (set.has(name)) set.delete(name); else set.add(name);
      lastClickedIndex.current = index;
      return Array.from(set);
    });
  };

  const clearSelection = () => setSelected([]);

  const setVisibilityForNames = (names: string[], value: boolean) => {
    setSeriesVisibility((current) => {
      const next = { ...current } as Record<string, boolean>;
      names.forEach((n) => { next[n] = value; });
      return next;
    });
  };

  const applyAxisToNames = (names: string[], axisKey: AxisKey) => {
    setSeriesAxis((current) => {
      const next = { ...current } as Record<string, AxisKey>;
      names.forEach((n) => { next[n] = axisKey; });
      return next;
    });
  };

  const setCollapsedAll = (collapsed: boolean) => {
    const files: Record<string, boolean> = {};
    const groups: Record<string, boolean> = {};
    grouped.forEach((gm, file) => {
      files[file] = collapsed;
      gm.forEach((_, gid) => { groups[`${file}::${gid}`] = collapsed; });
    });
    setCollapsedFiles(files);
    setCollapsedGroups(groups);
  };

  const autoAssignByUnit = () => {
    // Assign each encountered unit to next available axis, stable across run
    const unitToAxis = new Map<string, AxisKey>();
    const order: AxisKey[] = ['y1', 'y2', 'y3'];
    let ptr = 0;
    const pick = (unit: string | undefined): AxisKey => {
      if (!unit) return 'y1';
      if (!unitToAxis.has(unit)) {
        unitToAxis.set(unit, order[Math.min(ptr, order.length - 1)]);
        ptr = Math.min(ptr + 1, order.length - 1);
      }
      return unitToAxis.get(unit)!;
    };
    const names = descriptors.map((d) => d.name);
    setSeriesAxis((current) => {
      const next = { ...current } as Record<string, AxisKey>;
      descriptors.forEach((d) => { next[d.name] = pick(d.unit); });
      return next;
    });
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="app-subtitle">UART 通信ログ可視化ツール</p>
          <h1>Monitor Graph</h1>
        </div>
        {fileName && <span className="file-name">{fileName}</span>}
      </header>
      {loadedFiles.length > 0 && (
        <div className="file-chip-row">
          {loadedFiles.map((f) => (
            <div key={f.fileName} className="file-chip">
              <div className="file-chip-label">{f.label}</div>
              <div className="file-chip-name">{f.fileName}</div>
            </div>
          ))}
        </div>
      )}

      <section className="uploader">
        <label className="file-label" htmlFor="log-file">
          ログファイル（CSV / XLSX）を選択
        </label>
        <input
          id="log-file"
          key={inputKey}
          type="file"
          multiple
          accept=".csv,.xlsx,.xls"
          onChange={handleFile}
          disabled={isLoading}
        />
        <p className="hint">
          1列目: 日付、2列目: 時刻、3列目以降: 計測値（任意個）。ヘッダーは1行目に配置してください。
        </p>
      </section>

      {errorMessage && <div className="error">{errorMessage}</div>}

      {isLoading && <div className="loading">解析中...</div>}

      {parsedData && chartData ? (
        <>
          <section className="chart-section">
            <div className="chart-toolbar">
              <div className="left">
                <button type="button" className="btn" onClick={handleResetZoom}>
                  ズームリセット
                </button>
              </div>
              <div className="right">
                <span style={{ color: '#64748b', fontSize: '0.9rem' }}>表示 {visibleCount}/{seriesEntries.length}</span>
                <button type="button" className="btn" onClick={() => setShowTooltip((s) => !s)}>
                  ツールチップ {showTooltip ? 'ON' : 'OFF'}
                </button>
                <button type="button" className="btn" onClick={() => setIsFullscreen(true)}>
                  全画面表示
                </button>
                <button type="button" className="btn" onClick={() => setControlsOpen(true)}>
                  表示・軸設定
                </button>
              </div>
            </div>
            <p className="zoom-hint">ドラッグでズーム／Shift+ドラッグで移動／Ctrl+ホイールで拡大縮小</p>
            <Line ref={chartRef} options={chartOptions} data={chartData} />
          </section>

          {isFullscreen && (
            <div className="fullscreen-overlay">
              <div className="fullscreen-toolbar">
                <div className="left">
                  <button type="button" className="btn" onClick={handleResetZoom}>ズームリセット</button>
                  <button type="button" className="btn" onClick={() => setShowTooltip((s) => !s)}>
                    ツールチップ {showTooltip ? 'ON' : 'OFF'}
                  </button>
                </div>
                <div className="right">
                  <button type="button" className="btn" onClick={() => setControlsOpen(true)}>データ/軸設定</button>
                  <button type="button" className="btn" onClick={() => setIsFullscreen(false)}>閉じる</button>
                </div>
              </div>
              <div className="fullscreen-body">
                <Line ref={fullRef} options={chartOptions} data={chartData} />
              </div>
            </div>
          )}

          {/* Side controls panel */}
          <div className={"backdrop" + (controlsOpen ? ' show' : '')} onClick={() => setControlsOpen(false)} />
          <aside className={"side-panel" + (controlsOpen ? ' open' : '')} aria-label="データ/軸設定パネル">
            <div className="side-header">
              <strong>データ/軸設定</strong>
              <div className="side-header-actions">
                <button type="button" className="btn" onClick={() => setCollapsedAll(true)}>全て折りたたむ</button>
                <button type="button" className="btn" onClick={() => setCollapsedAll(false)}>全て展開</button>
                <button type="button" className="btn" onClick={autoAssignByUnit}>単位で自動割当</button>
                <button type="button" className="btn" onClick={() => setControlsOpen(false)}>閉じる</button>
              </div>
            </div>
            <div className="side-body">
              <div className="filter-row">
                <input
                  className="filter-input"
                  placeholder="列名でフィルター"
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                />
                <select className="sort-select" value={sortMode} onChange={(e) => setSortMode(e.target.value as any)}>
                  <option value="name">名前順</option>
                  <option value="latest">最近値</option>
                  <option value="variability">変動量</option>
                </select>
              </div>
              {selected.length > 0 && (
                <div className="selection-toolbar">
                  <span>{selected.length} 件選択中</span>
                  <button className="btn" type="button" onClick={() => setVisibilityForNames(selected, true)}>表示</button>
                  <button className="btn" type="button" onClick={() => setVisibilityForNames(selected, false)}>非表示</button>
                  <div className="axis-chips">
                    {AXIS_KEYS.map((k) => (
                      <button key={k} type="button" className={'chip ' + k} onClick={() => applyAxisToNames(selected, k)}>{AXIS_CONFIG[k].label}</button>
                    ))}
                  </div>
                  <button className="btn" type="button" onClick={clearSelection}>選択解除</button>
                </div>
              )}

              {/* Grouped list */}
              <div className="grouped-list">
                {Array.from(grouped.entries()).map(([file, gm]) => (
                  <div key={file} className="file-group-card">
                    <div className="file-group-header" onClick={() => setCollapsedFiles((c) => ({ ...c, [file]: !(c[file] ?? true) }))}>
                      <span className="file-name-strong">{file}</span>
                      <span className="spacer" />
                      <span className="muted">{Array.from(gm.values()).reduce((a, g) => a + g.items.length, 0)} 件</span>
                      <button className="btn ghost" type="button" onClick={(e) => { e.stopPropagation(); setCollapsedFiles((c) => ({ ...c, [file]: !(c[file] ?? true) })); }}>
                        {(collapsedFiles[file] ?? true) ? '展開' : '折りたたみ'}
                      </button>
                    </div>
                    {!(collapsedFiles[file] ?? true) && (
                      <div className="group-list">
                        {Array.from(gm.entries()).map(([gid, group]) => (
                          <div key={gid} className="group-card">
                            <div className="group-header" onClick={() => setCollapsedGroups((c) => ({ ...c, [`${file}::${gid}`]: !(c[`${file}::${gid}`] ?? true) }))}>
                              <strong>{group.groupLabel}</strong>
                              {group.unit && <span className="unit-badge">[{group.unit}]</span>}
                              <span className="spacer" />
                              <div className="group-actions" onClick={(e) => e.stopPropagation()}>
                                <button className="btn small" type="button" onClick={() => setVisibilityForNames(group.items.map(i => i.name), true)}>表示</button>
                                <button className="btn small" type="button" onClick={() => setVisibilityForNames(group.items.map(i => i.name), false)}>非表示</button>
                                <div className="axis-chips">
                                  {AXIS_KEYS.map((k) => (
                                    <button key={k} type="button" className={'chip small ' + k} onClick={() => applyAxisToNames(group.items.map(i => i.name), k)}>{k.toUpperCase()}</button>
                                  ))}
                                </div>
                              </div>
                              <button className="btn ghost" type="button" onClick={(e) => { e.stopPropagation(); setCollapsedGroups((c) => ({ ...c, [`${file}::${gid}`]: !(c[`${file}::${gid}`] ?? true) })); }}>
                                {(collapsedGroups[`${file}::${gid}`] ?? true) ? '展開' : '折りたたみ'}
                              </button>
                            </div>
                            {!(collapsedGroups[`${file}::${gid}`] ?? true) && (
                              <div className="series-list">
                                {group.items.map((d, idx) => {
                                  const indexInFlat = sortedDescriptors.findIndex((x) => x.name === d.name);
                                  const isSelected = selected.includes(d.name);
                                  return (
                                    <div key={d.name} className={'series-item' + (isSelected ? ' selected' : '')} onClick={(e) => toggleSelect(d.name, indexInFlat, e as any)}>
                                      <label className="series-toggle" onClick={(e) => e.stopPropagation()}>
                                        <input
                                          type="checkbox"
                                          checked={seriesVisibility[d.name] ?? true}
                                          onChange={() => toggleSeries(d.name)}
                                        />
                                        <span>{d.name}</span>
                                      </label>
                                      <div className="axis-chips" onClick={(e) => e.stopPropagation()}>
                                        {AXIS_KEYS.map((k) => (
                                          <button key={k} type="button" className={'chip ' + (seriesAxis[d.name] === k ? 'active ' : '') + k} onClick={() => handleAxisChange(d.name, k)}>{k.toUpperCase()}</button>
                                        ))}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div className="axis-range-panel">
                <div className="axis-range-grid">
                  {AXIS_KEYS.map((key) => (
                    <div key={key} className="axis-range-card">
                      <p className="axis-range-title">{AXIS_CONFIG[key].label}</p>
                      <div className="axis-range-inputs">
                        <label>
                          <span>最小値</span>
                          <input
                            type="number"
                            placeholder="auto"
                            value={axisRanges[key]?.min ?? ''}
                            onChange={(event) => handleAxisRangeChange(key, 'min', event.target.value)}
                          />
                        </label>
                        <label>
                          <span>最大値</span>
                          <input
                            type="number"
                            placeholder="auto"
                            value={axisRanges[key]?.max ?? ''}
                            onChange={(event) => handleAxisRangeChange(key, 'max', event.target.value)}
                          />
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </aside>
        </>
      ) : (
        !isLoading && <div className="placeholder">ファイルを選択するとここにグラフが表示されます。</div>
      )}

      {/* Version badge */}
      <div className="version-badge" title={`version ${appVersion}`}>v{appVersion}</div>
    </div>
  );
}

export default App;
