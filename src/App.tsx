import { ChangeEvent, useCallback, useMemo, useRef, useState } from 'react';
import Papa from 'papaparse';
import { Line } from 'react-chartjs-2';
import type { ChartData, ChartOptions, Plugin } from 'chart.js';
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

    for (const format of TIME_FORMATS) {
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

const composeTimestamp = (dateCell: CellValue, timeCell: CellValue): Date | null => {
  const datePart = parseDateCell(dateCell);
  if (!datePart) {
    return null;
  }

  const timePart = parseTimeCell(timeCell);

  return datePart
    .hour(timePart.hour)
    .minute(timePart.minute)
    .second(timePart.second)
    .millisecond(timePart.millisecond)
    .toDate();
};

const buildParsedData = (rows: DataRow[]): ParsedData => {
  const meaningfulRows = sanitizeRows(rows);

  if (meaningfulRows.length < 2) {
    throw new Error('有効なデータ行が見つかりません。');
  }

  const headers = meaningfulRows[0].map((cell) => (cell ?? '').toString().trim());
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

  for (let i = 1; i < meaningfulRows.length; i += 1) {
    const row = meaningfulRows[i];
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

const parseCsvFile = (file: File): Promise<DataRow[]> =>
  new Promise((resolve, reject) => {
    Papa.parse<string[]>(file, {
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
  const [fileName, setFileName] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [inputKey, setInputKey] = useState(Date.now());
  const appVersion = (pkg as { version?: string }).version ?? '0.0.0';
  const chartRef = useRef<ChartJS<'line'> | null>(null);

  const chartData = useChartData(parsedData, seriesVisibility, seriesAxis);

  const chartOptions = useMemo<ChartOptions<'line'>>(() => ({
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index' as const, intersect: false, axis: 'x' },
    plugins: {
      legend: {
        display: false
      },
      tooltip: {
        callbacks: {
          title(items: any[]) {
            const value = items[0]?.parsed?.x;
            if (value === undefined || value === null) {
              return '';
            }
            return dayjs(value).format('YYYY/MM/DD HH:mm:ss');
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
        ticks: { color: AXIS_CONFIG.y3.color },
        title: { display: true, text: AXIS_CONFIG.y3.label },
        offset: AXIS_CONFIG.y3.offset,
        grid: {
          drawOnChartArea: AXIS_CONFIG.y3.gridOnChart ?? false
        }
      }
    }
  }), []);

  const resetState = () => {
    setParsedData(null);
    setSeriesVisibility({});
    setSeriesAxis({});
    setFileName('');
  };

  const initializeSeriesState = (series: Record<string, (number | null)[]>) => {
    const visibility: Record<string, boolean> = {};
    const axis: Record<string, AxisKey> = {};
    Object.keys(series).forEach((key, index) => {
      visibility[key] = true;
      axis[key] = AXIS_KEYS[index % AXIS_KEYS.length];
    });
    setSeriesVisibility(visibility);
    setSeriesAxis(axis);
  };

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);
    setInputKey(Date.now());

    try {
      const extension = file.name.split('.').pop()?.toLowerCase();
      let rows: DataRow[];

      if (extension === 'csv') {
        rows = await parseCsvFile(file);
      } else if (extension === 'xlsx' || extension === 'xls') {
        rows = await parseXlsxFile(file);
      } else {
        throw new Error('CSV もしくは XLSX ファイルを選択してください。');
      }

      const parsed = buildParsedData(rows);
      setParsedData(parsed);
      initializeSeriesState(parsed.series);
      setFileName(file.name);
    } catch (error) {
      if (error instanceof Error) {
        setErrorMessage(error.message);
      } else {
        setErrorMessage('ファイルの読み込みに失敗しました。');
      }
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

  const handleResetZoom = useCallback(() => {
    chartRef.current?.resetZoom();
  }, []);

  const seriesEntries = parsedData ? Object.keys(parsedData.series) : [];

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="app-subtitle">UART 通信ログ可視化ツール</p>
          <h1>Monitor Graph</h1>
        </div>
        {fileName && <span className="file-name">{fileName}</span>}
      </header>

      <section className="uploader">
        <label className="file-label" htmlFor="log-file">
          ログファイル（CSV / XLSX）を選択
        </label>
        <input
          id="log-file"
          key={inputKey}
          type="file"
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
          <section className="series-panel">
            <div className="panel-header">
              <h2>表示するデータ列</h2>
              <div className="panel-actions">
                <button type="button" onClick={selectAll}>
                  全選択
                </button>
                <button type="button" onClick={clearAll}>
                  全解除
                </button>
                <button type="button" onClick={handleResetZoom}>
                  ズームリセット
                </button>
              </div>
            </div>
            <p className="axis-hint">各データ列ごとに最大3本の縦軸から割り当てを選択できます。</p>
            <div className="series-list">
              {seriesEntries.map((name) => (
                <div key={name} className="series-item">
                  <label className="series-toggle">
                    <input
                      type="checkbox"
                      checked={seriesVisibility[name] ?? true}
                      onChange={() => toggleSeries(name)}
                    />
                    <span>{name}</span>
                  </label>
                  <select
                    className="axis-select"
                    value={seriesAxis[name] ?? 'y1'}
                    onChange={(event) => handleAxisChange(name, event.target.value as AxisKey)}
                  >
                    {AXIS_OPTIONS.map((option) => (
                      <option key={option.key} value={option.key}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </section>

          <section className="chart-section">
            <p className="zoom-hint">ドラッグでズーム／Shift+ドラッグで移動／Ctrl+ホイールで拡大縮小</p>
            <Line ref={chartRef} options={chartOptions} data={chartData} />
          </section>
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
