import fs from 'node:fs';
import path from 'node:path';
import xlsx from 'xlsx';

const root = process.cwd();
const outDir = path.join(root, 'samples');
fs.mkdirSync(outDir, { recursive: true });

const pad = (n, w=2) => String(n).padStart(w, '0');
const fmtDate = (d) => `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())}`;
const fmtTimeFull = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3,'0')}`;
const fmtTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const fmtHm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtHHmm = (d) => `${pad(d.getHours())}${pad(d.getMinutes())}`;
const fmtHHmmss = (d) => `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const fmtDateDash = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

// Simple CSV with uniform formats
(function makeSimpleCsv(){
  const lines = [];
  lines.push(['Date','Time','Temp','Volt','Current'].join(','));
  const start = new Date(Date.UTC(2025,0,1,0,0,0,0));
  const rows = 60;
  for (let i=0;i<rows;i++){
    const t = new Date(start.getTime() + i*1000);
    const dateStr = fmtDate(t);
    const timeStr = fmtTimeFull(t);
    const temp = (25 + 2*Math.sin(i/10)).toFixed(2);
    const volt = (3.3 + 0.1*Math.cos(i/12)).toFixed(3);
    const current = (0.5 + 0.05*Math.sin(i/7)).toFixed(3);
    lines.push([dateStr,timeStr,temp,volt,current].join(','));
  }
  fs.writeFileSync(path.join(outDir,'uart_simple.csv'), lines.join('\n'), 'utf8');
})();

// CSV with mixed acceptable date/time formats
(function makeAltCsv(){
  const lines = [];
  lines.push(['Date','Time','Temp','Volt','Current'].join(','));
  const start = new Date(2025,5,1,12,0,0,0); // local time
  const rows = 12;
  const timeFormats = [fmtTimeFull, fmtTime, fmtHm, fmtHHmm, fmtHHmmss];
  const dateFormats = [fmtDate, fmtDateDash];
  for (let i=0;i<rows;i++){
    const t = new Date(start.getTime() + i*30*1000);
    const dateStr = dateFormats[i % dateFormats.length](t);
    const timeStr = timeFormats[i % timeFormats.length](t);
    const temp = (24 + 1.5*Math.sin(i/3)).toFixed(2);
    const volt = (3.28 + 0.08*Math.cos(i/4)).toFixed(3);
    const current = (0.48 + 0.04*Math.sin(i/2)).toFixed(3);
    lines.push([dateStr,timeStr,temp,volt,current].join(','));
  }
  fs.writeFileSync(path.join(outDir,'uart_alt_formats.csv'), lines.join('\n'), 'utf8');
})();

// XLSX with date-only and time-as-fraction (Excel serial-friendly)
(function makeXlsx(){
  const header = ['Date','Time','Temp','Volt','Current'];
  const start = new Date(2025,2,10,9,0,0,0); // local
  const rows = 40;
  const aoa = [header];
  for (let i=0;i<rows;i++){
    const t = new Date(start.getTime() + i*15000); // 15s step
    // Date-only (midnight) component
    const dateOnly = new Date(t.getFullYear(), t.getMonth(), t.getDate());
    // Time fraction of a day
    const seconds = t.getHours()*3600 + t.getMinutes()*60 + t.getSeconds() + t.getMilliseconds()/1000;
    const timeFraction = seconds / 86400; // Excel time serial
    const temp = 26 + 1.2*Math.sin(i/8);
    const volt = 3.30 + 0.05*Math.cos(i/10);
    const current = 0.52 + 0.03*Math.sin(i/5);
    aoa.push([dateOnly, timeFraction, +temp.toFixed(3), +volt.toFixed(3), +current.toFixed(3)]);
  }
  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.aoa_to_sheet(aoa);
  // Basic number formats for readability (optional)
  ws['A1'].z = 'yyyy/mm/dd';
  ws['B1'].z = 'hh:mm:ss';
  xlsx.utils.book_append_sheet(wb, ws, 'Logs');
  xlsx.writeFile(wb, path.join(outDir,'uart_excel_serial.xlsx'));
})();

console.log('Samples written to', outDir);
