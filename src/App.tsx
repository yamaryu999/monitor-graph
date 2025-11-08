import { ChangeEvent, useMemo, useState } from 'react';
import Papa from 'papaparse';
import { Line } from 'react-chartjs-2';
import type { ChartData } from 'chart.js';
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
import 'chartjs-adapter-date-fns';
import * as XLSX from 'xlsx';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import './App.css';
import pkg from '../package.json';

dayjs.extend(customParseFormat);

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, TimeScale, Tooltip, Legend, Filler);

type CellValue = string | number | Date | null | undefined;
type DataRow = CellValue[];

type ParsedData = {
  timestamps: Date[];
  series: Record<string, (number | null)[]>;
};

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
  seriesVisibility: Record<string, boolean>
): ChartData<'line'> | null =>
  useMemo(() => {
    if (!parsed) {
      return null;
    }

    const datasetEntries = Object.entries(parsed.series);

    return {
      labels: parsed.timestamps,
      datasets: datasetEntries.map(([label, values], index) => {
        const colors = colorFromIndex(index);
        const isVisible = seriesVisibility[label] ?? true;
        return {
          type: 'line' as const,
          label,
          data: values,
          borderColor: colors.border,
          backgroundColor: colors.background,
          spanGaps: true,
          pointRadius: 2,
          tension: 0.2,
          hidden: !isVisible
        };
      })
    } satisfies ChartData<'line'>;
  }, [parsed, seriesVisibility]);

function App() {
  const appVersion = (pkg as { version?: string }).version ?? '0.0.0';
  const [parsedData, setParsedData] = useState<ParsedData | null>(null);
  const [seriesVisibility, setSeriesVisibility] = useState<Record<string, boolean>>({});
  const [fileName, setFileName] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [inputKey, setInputKey] = useState(Date.now());

  const chartData = useChartData(parsedData, seriesVisibility);

  const chartOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index' as const, intersect: false },
    plugins: {
      legend: {
        display: false
      },
      tooltip: {
        callbacks: {
          title(items: any[]) {
            const value = items[0]?.label;
            if (!value) {
              return '';
            }
            const date = new Date(value);
            return dayjs(date).format('YYYY/MM/DD HH:mm:ss');
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
      y: {
        beginAtZero: false
      }
    }
  }), []);

  const resetState = () => {
    setParsedData(null);
    setSeriesVisibility({});
    setFileName('');
  };

  const initializeVisibility = (series: Record<string, (number | null)[]>) => {
    const nextState: Record<string, boolean> = {};
    Object.keys(series).forEach((key) => {
      nextState[key] = true;
    });
    setSeriesVisibility(nextState);
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
      initializeVisibility(parsed.series);
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
              </div>
            </div>
            <div className="series-list">
              {seriesEntries.map((name) => (
                <label key={name} className="series-item">
                  <input
                    type="checkbox"
                    checked={seriesVisibility[name] ?? true}
                    onChange={() => toggleSeries(name)}
                  />
                  <span>{name}</span>
                </label>
              ))}
            </div>
          </section>

          <section className="chart-section">
            <Line options={chartOptions} data={chartData} />
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
