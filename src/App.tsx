import { ChangeEvent, MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Line } from 'react-chartjs-2';
import type {
  ChartData,
  ChartOptions,
  Plugin,
  TooltipItem,
  TooltipModel,
  TooltipPositionerFunction
} from 'chart.js';
import {
  CategoryScale,
  Chart as ChartJS,
  Decimation,
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
import dayjs from 'dayjs';
import { parseFileInputs, type ParseFileInput, type ParsedData, type ParsedDataset } from './lib/dataParser';
import './App.css';
import pkg from '../package.json';

declare module 'chart.js' {
  interface TooltipPositionerMap {
    cursorOffset: TooltipPositionerFunction<'line'>;
  }
}

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
  Decimation,
  zoomPlugin,
  hoverLinePlugin
);

const cursorOffsetPositioner: TooltipPositionerFunction<'line'> = function cursorOffset(
  this: TooltipModel<'line'>,
  _items,
  eventPosition
) {
  if (!eventPosition) return false;
  const tooltip = this as TooltipModel<'line'>;
  const chartArea = tooltip?.chart?.chartArea;
  const width = tooltip?.width ?? 160;
  const height = tooltip?.height ?? 60;

  if (!chartArea) {
    return { x: eventPosition.x + 60, y: Math.max(eventPosition.y - height, 0) };
  }

  const padding = 16;
  const candidates = [
    { x: chartArea.left + padding, y: chartArea.top + padding },
    { x: chartArea.right - width - padding, y: chartArea.top + padding },
    { x: chartArea.left + padding, y: chartArea.bottom - height - padding },
    { x: chartArea.right - width - padding, y: chartArea.bottom - height - padding }
  ];

  const best = candidates.reduce(
    (acc, pos) => {
      const dist = (pos.x - eventPosition.x) ** 2 + (pos.y - eventPosition.y) ** 2;
      if (dist > acc.distance) {
        return { distance: dist, position: pos };
      }
      return acc;
    },
    { distance: -Infinity, position: candidates[0] }
  );

  const minX = chartArea.left + padding;
  const maxX = chartArea.right - width - padding;
  const minY = chartArea.top + padding;
  const maxY = chartArea.bottom - height - padding;

  return {
    x: Math.min(Math.max(best.position.x, minX), maxX),
    y: Math.min(Math.max(best.position.y, minY), maxY)
  };
};

Tooltip.positioners.cursorOffset = cursorOffsetPositioner;

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

const parseFilterBoundary = (value: string): Date | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const candidate = dayjs(trimmed);
  return candidate.isValid() ? candidate.toDate() : null;
};

const applyDataFilters = (
  data: ParsedData,
  options: { stride: number; startText: string; endText: string }
): ParsedData => {
  const stride = Number.isFinite(options.stride) && options.stride > 1 ? Math.floor(options.stride) : 1;
  let startDate = parseFilterBoundary(options.startText);
  let endDate = parseFilterBoundary(options.endText);
  if (startDate && endDate && startDate > endDate) {
    [startDate, endDate] = [endDate, startDate];
  }

  const entries = Object.entries(data.series);
  const filteredSeries = entries.reduce((acc, [key]) => {
    acc[key] = [];
    return acc;
  }, {} as Record<string, (number | null)[]>);

  const filteredTimestamps: Date[] = [];
  let accepted = 0;

  data.timestamps.forEach((timestamp, index) => {
    if (startDate && timestamp < startDate) return;
    if (endDate && timestamp > endDate) return;
    const include = stride === 1 || accepted % stride === 0;
    accepted += 1;
    if (!include) return;
    filteredTimestamps.push(timestamp);
    entries.forEach(([key, values]) => {
      filteredSeries[key].push(values[index] ?? null);
    });
  });

  return { timestamps: filteredTimestamps, series: filteredSeries };
};

type ParserWorkerResponse =
  | { id: string; success: true; payload: ParsedDataset[] }
  | { id: string; success: false; error: string };

const AXIS_KEYS = ['y1', 'y2', 'y3'] as const;
type AxisKey = (typeof AXIS_KEYS)[number];

const AXIS_CONFIG: Record<AxisKey, { label: string; position: 'left' | 'right'; color: string; offset?: boolean; gridOnChart?: boolean }> = {
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

const createAxisAutoState = (): Record<AxisKey, boolean> =>
  AXIS_KEYS.reduce((acc, key) => {
    acc[key] = true;
    return acc;
  }, {} as Record<AxisKey, boolean>);

type PresetPayload = {
  seriesVisibility: Record<string, boolean>;
  seriesAxis: Record<string, AxisKey>;
  axisRanges: AxisRangeState;
  axisAuto: Record<AxisKey, boolean>;
  showTooltip: boolean;
  sortMode: 'name' | 'latest' | 'variability';
};

type DisplayPreset = {
  id: string;
  name: string;
  savedAt: string;
  payload: PresetPayload;
};

const PRESET_STORAGE_KEY = 'monitor-graph:display-presets';

const cloneAxisRangeState = (source: AxisRangeState): AxisRangeState =>
  AXIS_KEYS.reduce((acc, key) => {
    acc[key] = { ...source[key] };
    return acc;
  }, {} as AxisRangeState);

const cloneAxisAutoState = (source: Record<AxisKey, boolean>): Record<AxisKey, boolean> =>
  AXIS_KEYS.reduce((acc, key) => {
    acc[key] = source[key] ?? true;
    return acc;
  }, {} as Record<AxisKey, boolean>);

const coerceAxisRangeState = (input?: Partial<Record<AxisKey, Partial<{ min: string; max: string }>>>): AxisRangeState => {
  const base = createAxisRangeState();
  AXIS_KEYS.forEach((key) => {
    base[key] = {
      min: input?.[key]?.min ?? '',
      max: input?.[key]?.max ?? ''
    };
  });
  return base;
};

const coerceAxisAutoState = (input?: Partial<Record<AxisKey, boolean>>): Record<AxisKey, boolean> => {
  const base = createAxisAutoState();
  AXIS_KEYS.forEach((key) => {
    if (typeof input?.[key] === 'boolean') {
      base[key] = input[key] as boolean;
    }
  });
  return base;
};

const generatePresetId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `preset-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const normalizePreset = (raw: unknown): DisplayPreset | null => {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Partial<DisplayPreset> & { payload?: Partial<PresetPayload> };
  const payload = (entry.payload ?? {}) as Partial<PresetPayload>;
  const sv: Record<string, boolean> = {};
  if (payload.seriesVisibility && typeof payload.seriesVisibility === 'object') {
    Object.entries(payload.seriesVisibility).forEach(([key, value]) => {
      sv[key] = typeof value === 'boolean' ? value : Boolean(value);
    });
  }
  const axis: Record<string, AxisKey> = {};
  if (payload.seriesAxis && typeof payload.seriesAxis === 'object') {
    Object.entries(payload.seriesAxis).forEach(([key, value]) => {
      axis[key] = AXIS_KEYS.includes(value as AxisKey) ? (value as AxisKey) : 'y1';
    });
  }
  const sortMode: PresetPayload['sortMode'] =
    payload.sortMode === 'latest' || payload.sortMode === 'variability' ? payload.sortMode : 'name';
  return {
    id: typeof entry.id === 'string' ? entry.id : generatePresetId(),
    name: typeof entry.name === 'string' ? entry.name : 'プリセット',
    savedAt: typeof entry.savedAt === 'string' ? entry.savedAt : new Date().toISOString(),
    payload: {
      seriesVisibility: sv,
      seriesAxis: axis,
      axisRanges: payload.axisRanges ? coerceAxisRangeState(payload.axisRanges) : createAxisRangeState(),
      axisAuto: payload.axisAuto ? coerceAxisAutoState(payload.axisAuto) : createAxisAutoState(),
      showTooltip: typeof payload.showTooltip === 'boolean' ? payload.showTooltip : true,
      sortMode
    }
  };
};

const loadStoredPresets = (): DisplayPreset[] => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(PRESET_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => normalizePreset(item)).filter(Boolean) as DisplayPreset[];
  } catch {
    return [];
  }
};

const persistPresets = (items: DisplayPreset[]) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // noop
  }
};

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
    const totalPoints = parsed.timestamps.length;

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
          pointRadius: totalPoints > 1500 ? 0 : 2,
          pointHoverRadius: 3,
          pointHitRadius: 3,
          tension: 0.2,
          hidden: !isVisible,
          parsing: false,
          yAxisID: seriesAxis[label] ?? 'y1'
        };
      })
    } satisfies ChartData<'line'>;
  }, [parsed, seriesAxis, seriesVisibility]);

function App() {
  const [parsedData, setParsedData] = useState<ParsedData | null>(null);
  const [baseData, setBaseData] = useState<ParsedData | null>(null);
  const [seriesVisibility, setSeriesVisibility] = useState<Record<string, boolean>>({});
  const [seriesAxis, setSeriesAxis] = useState<Record<string, AxisKey>>({});
  const [axisRanges, setAxisRanges] = useState<AxisRangeState>(() => createAxisRangeState());
  const [axisAuto, setAxisAuto] = useState<Record<AxisKey, boolean>>(() => createAxisAutoState());
  const [controlsOpen, setControlsOpen] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [bulkAxis, setBulkAxis] = useState<AxisKey>('y1');
  const [presets, setPresets] = useState<DisplayPreset[]>(() => loadStoredPresets());
  const [presetName, setPresetName] = useState('');
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [showTooltip, setShowTooltip] = useState(true);
  const [loadedFiles, setLoadedFiles] = useState<{ fileName: string; label: string }[]>([]);
  const [fileName, setFileName] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [inputKey, setInputKey] = useState(Date.now());
  const appVersion = (pkg as { version?: string }).version ?? '0.0.0';
  const chartRef = useRef<ChartJS<'line'> | null>(null);
  const fullRef = useRef<ChartJS<'line'> | null>(null);
  const presetFileInputRef = useRef<HTMLInputElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [sortMode, setSortMode] = useState<'name' | 'latest' | 'variability'>('name');
  const [selected, setSelected] = useState<string[]>([]);
  const lastClickedIndex = useRef<number | null>(null);
  const [collapsedFiles, setCollapsedFiles] = useState<Record<string, boolean>>({});
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [rowStride, setRowStride] = useState(1);
  const [timeFilterStart, setTimeFilterStart] = useState('');
  const [timeFilterEnd, setTimeFilterEnd] = useState('');
  const parserWorkerRef = useRef<Worker | null>(null);
  const pendingParses = useRef(
    new Map<string, { resolve: (value: ParsedDataset[]) => void; reject: (error: Error) => void }>()
  );

  useEffect(() => {
    persistPresets(presets);
  }, [presets]);

  useEffect(() => {
    if (selectedPresetId && !presets.some((preset) => preset.id === selectedPresetId)) {
      setSelectedPresetId('');
    }
  }, [presets, selectedPresetId]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof Worker === 'undefined') {
      return undefined;
    }
    const worker = new Worker(new URL('./workers/parserWorker.ts', import.meta.url), { type: 'module' });
    parserWorkerRef.current = worker;

    worker.onmessage = (event: MessageEvent<ParserWorkerResponse>) => {
      const message = event.data;
      const pending = pendingParses.current.get(message.id);
      if (!pending) {
        return;
      }
      pendingParses.current.delete(message.id);
      if (message.success) {
        pending.resolve(message.payload);
      } else {
        const errorText = 'error' in message ? message.error ?? '解析に失敗しました。' : '解析に失敗しました。';
        pending.reject(new Error(errorText));
      }
    };

    worker.onerror = (event) => {
      const error = new Error(event.message || '解析ワーカーでエラーが発生しました。');
      pendingParses.current.forEach((pending) => pending.reject(error));
      pendingParses.current.clear();
    };

    return () => {
      pendingParses.current.forEach((pending) => pending.reject(new Error('解析ワーカーが停止しました。')));
      pendingParses.current.clear();
      worker.terminate();
      if (parserWorkerRef.current === worker) {
        parserWorkerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!baseData) {
      setParsedData(null);
      return;
    }
    const filtered = applyDataFilters(baseData, {
      stride: rowStride,
      startText: timeFilterStart,
      endText: timeFilterEnd
    });
    setParsedData(filtered);
  }, [baseData, rowStride, timeFilterStart, timeFilterEnd]);

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
      acc[key] = axisAuto[key]
        ? { min: undefined, max: undefined }
        : {
            min: toNumber(axisRanges[key]?.min),
            max: toNumber(axisRanges[key]?.max)
          };
      return acc;
    }, {} as Record<AxisKey, { min?: number; max?: number }>);

    return {
    responsive: true,
    maintainAspectRatio: false,
    parsing: false,
    normalized: true,
    animation: false,
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
        position: 'cursorOffset' as const,
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
      decimation: {
        enabled: true,
        algorithm: 'lttb',
        samples: 1500
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
        },
        ticks: { maxTicksLimit: 10 }
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
  }, [axisAuto, axisRanges, seriesVisibility, showTooltip]);

  const resetState = () => {
    setParsedData(null);
    setBaseData(null);
    setSeriesVisibility({});
    setSeriesAxis({});
    setAxisRanges(createAxisRangeState());
    setAxisAuto(createAxisAutoState());
    setFileName('');
    setLoadedFiles([]);
  };

  const resetAxisRanges = () => {
    setAxisRanges(createAxisRangeState());
    setAxisAuto(createAxisAutoState());
  };

  const parseFilesWithWorker = useCallback(async (files: File[]): Promise<ParsedDataset[]> => {
    const prepared: ParseFileInput[] = [];
    for (const file of files) {
      // eslint-disable-next-line no-await-in-loop
      const buffer = await file.arrayBuffer();
      prepared.push({ name: file.name, buffer, type: file.type });
    }

    const worker = parserWorkerRef.current;
    if (worker) {
      const requestId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

      const transferables = prepared.map((file) => file.buffer);
      const promise = new Promise<ParsedDataset[]>((resolve, reject) => {
        pendingParses.current.set(requestId, { resolve, reject });
      });

      try {
        worker.postMessage({ id: requestId, files: prepared }, transferables as Transferable[]);
        return await promise;
      } catch (error) {
        pendingParses.current.delete(requestId);
        worker.terminate();
        if (parserWorkerRef.current === worker) {
          parserWorkerRef.current = null;
        }
        console.error('解析ワーカーにメッセージを送信できませんでした。メインスレッドで解析します。', error);
      }
    }

    return parseFileInputs(prepared);
  }, []);

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
      const datasets = await parseFilesWithWorker(files);
      const labeled = annotateDatasetLabels(datasets);
      const merged = mergeParsedDatasets(labeled);
      setBaseData(merged);
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
    setAxisAuto((current) => ({ ...current, [axisKey]: false }));
    setAxisRanges((current) => ({
      ...current,
      [axisKey]: {
        ...current[axisKey],
        [field]: value
      }
    }));
  };

  const handleAxisModeChange = (axisKey: AxisKey, autoMode: boolean) => {
    setAxisAuto((current) => ({ ...current, [axisKey]: autoMode }));
    if (autoMode) {
      setAxisRanges((current) => ({
        ...current,
        [axisKey]: { min: '', max: '' }
      }));
    }
  };

  const handleFitAxis = (axisKey: AxisKey) => {
    if (!parsedData) return;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    Object.entries(parsedData.series).forEach(([name, values]) => {
      if ((seriesAxis[name] ?? 'y1') !== axisKey) return;
      if (seriesVisibility[name] === false) return;
      values.forEach((value) => {
        if (typeof value === 'number' && Number.isFinite(value)) {
          if (value < min) min = value;
          if (value > max) max = value;
        }
      });
    });
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return;
    }
    if (min === max) {
      const padding = Math.abs(min || 1) * 0.05 || 1;
      min -= padding;
      max += padding;
    }
    const margin = (max - min) * 0.05;
    const nextMin = min - margin;
    const nextMax = max + margin;
    setAxisRanges((current) => ({
      ...current,
      [axisKey]: {
        min: Number(nextMin.toPrecision(8)).toString(),
        max: Number(nextMax.toPrecision(8)).toString()
      }
    }));
    setAxisAuto((current) => ({ ...current, [axisKey]: false }));
  };

  const buildPresetPayload = (): PresetPayload => ({
    seriesVisibility: { ...seriesVisibility },
    seriesAxis: { ...seriesAxis },
    axisRanges: cloneAxisRangeState(axisRanges),
    axisAuto: cloneAxisAutoState(axisAuto),
    showTooltip,
    sortMode
  });

  const applyPreset = (preset: DisplayPreset) => {
    setSeriesVisibility({ ...preset.payload.seriesVisibility });
    setSeriesAxis({ ...preset.payload.seriesAxis });
    setAxisRanges(cloneAxisRangeState(preset.payload.axisRanges ?? createAxisRangeState()));
    setAxisAuto(cloneAxisAutoState(preset.payload.axisAuto ?? createAxisAutoState()));
    setShowTooltip(preset.payload.showTooltip);
    setSortMode(preset.payload.sortMode);
  };

  const handleSavePreset = () => {
    const name = presetName.trim();
    if (!name) return;
    const payload = buildPresetPayload();
    const savedAt = new Date().toISOString();
    let nextSelectedId = '';
    setPresets((current) => {
      const existing = current.find((p) => p.name === name);
      if (existing) {
        nextSelectedId = existing.id;
        return current.map((p) => (p.id === existing.id ? { ...existing, payload, savedAt } : p));
      }
      const newPreset: DisplayPreset = { id: generatePresetId(), name, savedAt, payload };
      nextSelectedId = newPreset.id;
      return [...current, newPreset];
    });
    setPresetName('');
    if (nextSelectedId) {
      setSelectedPresetId(nextSelectedId);
    }
  };

  const handleLoadPreset = (presetId: string) => {
    const preset = presets.find((p) => p.id === presetId);
    if (!preset) return;
    applyPreset(preset);
    setSelectedPresetId(presetId);
  };

  const handleDeletePreset = (presetId: string) => {
    if (!presetId) return;
    setPresets((current) => current.filter((p) => p.id !== presetId));
    if (selectedPresetId === presetId) {
      setSelectedPresetId('');
    }
  };

  const handleExportPresets = () => {
    if (!presets.length || typeof window === 'undefined') return;
    try {
      const blob = new Blob([JSON.stringify(presets, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'monitor-graph-presets.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // noop
    }
  };

  const handleImportPresets = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) return;
      const normalized = parsed.map((entry) => normalizePreset(entry)).filter(Boolean) as DisplayPreset[];
      if (!normalized.length) return;
      setPresets((current) => {
        const map = new Map(current.map((p) => [p.id, p]));
        normalized.forEach((preset) => {
          map.set(preset.id, preset);
        });
        return Array.from(map.values());
      });
    } catch {
      // noop
    } finally {
      event.target.value = '';
    }
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
        <div className="pre-filter-row">
          <div className="pre-filter-item">
            <label htmlFor="row-stride">サンプリング</label>
            <select
              id="row-stride"
              value={rowStride}
              onChange={(event) => setRowStride(Number(event.target.value) || 1)}
              disabled={isLoading}
            >
              <option value={1}>全件</option>
              <option value={2}>1/2 サンプリング</option>
              <option value={5}>1/5 サンプリング</option>
              <option value={10}>1/10 サンプリング</option>
            </select>
          </div>
          <div className="pre-filter-item">
            <label htmlFor="filter-start">開始時刻 (任意)</label>
            <input
              id="filter-start"
              type="text"
              placeholder="例: 2025/11/16 08:00"
              value={timeFilterStart}
              onChange={(event) => setTimeFilterStart(event.target.value)}
              disabled={isLoading}
            />
          </div>
          <div className="pre-filter-item">
            <label htmlFor="filter-end">終了時刻 (任意)</label>
            <input
              id="filter-end"
              type="text"
              placeholder="例: 2025/11/16 12:00"
              value={timeFilterEnd}
              onChange={(event) => setTimeFilterEnd(event.target.value)}
              disabled={isLoading}
            />
          </div>
        </div>
        <p className="hint">上記フィルタは読み込み済みデータにも即時反映されます。</p>
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
              <section className="panel-section">
                <div className="section-header">
                  <p className="section-eyebrow">検索 / 絞り込み</p>
                  <h3>シリーズを整理</h3>
                  <p className="section-caption">名前や指標で素早く探し、一括表示を切り替えます。</p>
                </div>
                <div className="filter-grid">
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
                <div className="visibility-toolbar">
                  <button type="button" className="btn" onClick={selectAll}>全て表示</button>
                  <button type="button" className="btn" onClick={clearAll}>全て非表示</button>
                </div>
              </section>

              {selected.length > 0 && (
                <section className="panel-section selection-section">
                  <div className="section-header">
                    <p className="section-eyebrow">選択操作</p>
                    <h3>{selected.length} 件選択中</h3>
                    <p className="section-caption">表示状態や軸割り当てをまとめて変更できます。</p>
                  </div>
                  <div className="selection-toolbar">
                    <div className="selection-buttons">
                      <button className="btn" type="button" onClick={() => setVisibilityForNames(selected, true)}>表示</button>
                      <button className="btn" type="button" onClick={() => setVisibilityForNames(selected, false)}>非表示</button>
                      <button className="btn ghost" type="button" onClick={clearSelection}>選択解除</button>
                    </div>
                    <div className="axis-segment-group ghost" role="group" aria-label="選択中の軸を変更">
                      {AXIS_KEYS.map((k) => (
                        <button
                          key={k}
                          type="button"
                          className={`axis-segment ${k}${bulkAxis === k ? ' active' : ''}`}
                          aria-pressed={bulkAxis === k}
                          onClick={() => {
                            setBulkAxis(k);
                            applyAxisToNames(selected, k);
                          }}
                        >
                          {k.toUpperCase()}
                        </button>
                      ))}
                    </div>
                  </div>
                </section>
              )}

              <section className="panel-section">
                <div className="section-header">
                  <p className="section-eyebrow">グループ</p>
                  <h3>系列ごとの操作</h3>
                  <p className="section-caption">ファイル → グループ → シリーズの階層で整理しています。</p>
                </div>
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
                                  <div className="axis-segment-group compact" role="group" aria-label={`${group.groupLabel} の軸切替`}>
                                    {AXIS_KEYS.map((k) => (
                                      <button
                                        key={k}
                                        type="button"
                                        className={`axis-segment ${k}`}
                                        onClick={() => applyAxisToNames(group.items.map(i => i.name), k)}
                                      >
                                        {k.toUpperCase()}
                                      </button>
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
                                        <div className="axis-segment-group" role="group" aria-label={`${d.name} の軸選択`} onClick={(e) => e.stopPropagation()}>
                                          {AXIS_KEYS.map((k) => {
                                            const isActive = (seriesAxis[d.name] ?? 'y1') === k;
                                            return (
                                              <button
                                                key={k}
                                                type="button"
                                                className={`axis-segment ${k}${isActive ? ' active' : ''}`}
                                                aria-pressed={isActive}
                                                onClick={() => handleAxisChange(d.name, k)}
                                              >
                                                {k.toUpperCase()}
                                              </button>
                                            );
                                          })}
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
              </section>

              <section className="panel-section axis-panel">
                <div className="section-header">
                  <p className="section-eyebrow">表示 / 軸</p>
                  <h3>マテリアル軸コントロール</h3>
                  <p className="section-caption">グラフのトーンやプリセット、軸レンジをまとめて管理できます。</p>
                </div>
                <div className="axis-display-section">
                  <div className="axis-display-toolbar">
                    <button
                      type="button"
                      className={`material-toggle${showTooltip ? ' on' : ''}`}
                      onClick={() => setShowTooltip((s) => !s)}
                    >
                      <span>ツールチップ</span>
                      <strong>{showTooltip ? 'ON' : 'OFF'}</strong>
                    </button>
                    <button type="button" className="material-outline" onClick={resetAxisRanges}>
                      軸レンジリセット
                    </button>
                  </div>
                  <div className="preset-panel">
                    <div className="preset-save-row">
                      <input
                        className="preset-input"
                        placeholder="プリセット名を入力"
                        value={presetName}
                        onChange={(event) => setPresetName(event.target.value)}
                      />
                      <button
                        type="button"
                        className="material-outline"
                        onClick={handleSavePreset}
                        disabled={!presetName.trim()}
                      >
                        保存
                      </button>
                    </div>
                    <div className="preset-load-row">
                      <select
                        className="preset-select"
                        value={selectedPresetId}
                        onChange={(event) => setSelectedPresetId(event.target.value)}
                      >
                        <option value="">プリセットを選択</option>
                        {presets.map((preset) => {
                          const saved = dayjs(preset.savedAt);
                          const stamp = saved.isValid() ? saved.format('MM/DD HH:mm') : preset.savedAt;
                          return (
                            <option key={preset.id} value={preset.id}>
                              {preset.name}（{stamp}）
                            </option>
                          );
                        })}
                      </select>
                      <button
                        type="button"
                        className="material-outline tiny"
                        onClick={() => handleLoadPreset(selectedPresetId)}
                        disabled={!selectedPresetId}
                      >
                        読込
                      </button>
                      <button
                        type="button"
                        className="material-outline tiny"
                        onClick={() => handleDeletePreset(selectedPresetId)}
                        disabled={!selectedPresetId}
                      >
                        削除
                      </button>
                      <button
                        type="button"
                        className="material-outline tiny"
                        onClick={handleExportPresets}
                        disabled={!presets.length}
                      >
                        JSON書出
                      </button>
                      <button
                        type="button"
                        className="material-outline tiny"
                        onClick={() => presetFileInputRef.current?.click()}
                      >
                        JSON読込
                      </button>
                      <input
                        ref={presetFileInputRef}
                        type="file"
                        accept="application/json"
                        style={{ display: 'none' }}
                        onChange={handleImportPresets}
                      />
                    </div>
                    {!presets.length && (
                      <p className="preset-hint">まだプリセットはありません。設定を保存するとここに一覧表示されます。</p>
                    )}
                  </div>
                  <div className="axis-range-panel material-card">
                    <div className="axis-range-grid">
                      {AXIS_KEYS.map((key) => (
                        <div key={key} className="axis-range-card">
                          <div className="axis-range-head">
                            <p className="axis-range-title">{AXIS_CONFIG[key].label}</p>
                            <div className="axis-mode-toggle" role="group" aria-label={`${AXIS_CONFIG[key].label} モード切替`}>
                              <button
                                type="button"
                                className={'mode-chip' + (axisAuto[key] ? ' active' : '')}
                                aria-pressed={axisAuto[key]}
                                onClick={() => handleAxisModeChange(key, true)}
                              >
                                AUTO
                              </button>
                              <button
                                type="button"
                                className={'mode-chip' + (!axisAuto[key] ? ' active' : '')}
                                aria-pressed={!axisAuto[key]}
                                onClick={() => handleAxisModeChange(key, false)}
                              >
                                固定
                              </button>
                            </div>
                          </div>
                          <div className="axis-mode-actions">
                            <span className="axis-mode-caption">
                              {axisAuto[key] ? 'データに合わせて自動調整します' : '入力値でレンジを固定します'}
                            </span>
                            <button
                              type="button"
                              className="material-outline tiny"
                              onClick={() => handleFitAxis(key)}
                              disabled={!parsedData}
                            >
                              FIT
                            </button>
                          </div>
                          <div className="axis-range-inputs">
                            <label>
                              <span>最小値</span>
                              <input
                                type="number"
                                placeholder="auto"
                                value={axisRanges[key]?.min ?? ''}
                                disabled={axisAuto[key]}
                                onChange={(event) => handleAxisRangeChange(key, 'min', event.target.value)}
                              />
                            </label>
                            <label>
                              <span>最大値</span>
                              <input
                                type="number"
                                placeholder="auto"
                                value={axisRanges[key]?.max ?? ''}
                                disabled={axisAuto[key]}
                                onChange={(event) => handleAxisRangeChange(key, 'max', event.target.value)}
                              />
                            </label>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </section>
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
