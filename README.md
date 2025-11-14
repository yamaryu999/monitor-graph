# Monitor Graph — 開発ハンドオフ/運用ガイド

本リポジトリは、UART 通信ログ（CSV / XLSX）を読み込み、Web ブラウザでグラフ可視化するアプリです。次回以降に新しいチャット/担当者へ引き継ぎしやすいよう、開発・運用の要点をまとめています。

## 概要
- フロントエンド: React + Vite + TypeScript
- チャート: Chart.js v4 + react-chartjs-2 + chartjs-plugin-zoom
- 解析/フォーマット: PapaParse, xlsx, dayjs, encoding-japanese
- デプロイ: Netlify（静的ホスティング）
- バージョン表示: `package.json` の `version` を右下バッジに表示

## クイックスタート
- 開発: `npm run dev`（Vite 開発サーバ 5173）
- ビルド: `npm run build`（`dist/` 出力）
- プレビュー: `npm run preview`
- Netlify 設定: ルートをプロジェクト直下、ビルドコマンド `npm run build`、公開ディレクトリ `dist`

## データ仕様（CSV / XLSX）
- ヘッダ行は「1行目」に配置
- 1列目: 日付、2列目: 時刻、3列目以降: データ列（任意個）
- 先頭にメタ情報行が複数混在していても、最初の「3列以上の行」をヘッダとして自動検出
- 文字コード: UTF-8 自動判定 → 失敗時は encoding-japanese による検出 → 最終的に Shift_JIS を試行
- Excel 由来の時刻先頭 `'`（例: `'00:00:01.0`）は正規化してから解析
- 時刻/日付の組み立て: 1列目(=日付)/2列目(=時刻) もしくは 1列目(=時刻)/2列目(=日付) のいずれにも対応
- 対応フォーマット例
  - 日付: `YYYY/MM/DD`, `YYYY-MM-DD`, `YYYY.MM.DD`, `YYYYMMDD`, など
  - 時刻: `HH:mm:ss.SSS`, `HH:mm:ss`, `HH:mm`, `HHmmss`, `HHmm`

サンプル: `samples/20251024143432CH1_0.csv`, `samples/20251024143432CH2_0.csv`

## 複数ファイル
- 最大 2 ファイルまで同時ロード可能
- タイムスタンプは和集合で統合（存在しない点は `null`）
- 各系列名は `[ファイル表示名] 元の列名` を付加して区別

## 主な機能
- ズーム/パン: ドラッグでズーム、Shift+ドラッグでパン、Ctrl+ホイールで拡大縮小
- ツールチップ: ON/OFF 切替、表示対象のデータのみ表示、カーソルから離れた位置へ自動ドッキング（チャート内最遠角）
- ガイド線: カーソル位置に縦の点線（太線強調や外部ツールチップは採用しない）
- 軸: Y1/Y2/Y3 の 3 軸に任意系列を割当、各軸の最小/最大を設定可
- グルーピング: ファイル → 単位/キーワード → シリーズ の階層構造
  - グループ単位で表示/非表示・軸割当を一括操作
  - 初期状態はすべて折りたたみ
- マルチ選択: シリーズを Shift+クリックで範囲選択し、ツールバーで一括操作
- 並び替え: 名前 / 最近値 / 変動量
- 全画面表示: オーバーレイに拡大。全画面中もパネル/軸操作可
- 全表示/全非表示: サイドパネル上部の「全て表示 / 全て非表示」

## パフォーマンス最適化
- Chart.js Decimation（LTTB, 1500 samples）
- `parsing: false`, `normalized: true`, `animation: false`
- データ点が大きい場合は `pointRadius: 0` に自動切替
- X 軸目盛の最大数を制限（`ticks.maxTicksLimit`）

調整する場合は `src/App.tsx` 内の下記を編集:
- デシメーションのサンプル数: `plugins.decimation.samples`
- 点の閾値: `pointRadius: totalPoints > 1500 ? 0 : 2`

## 画面・操作の要点
- ヘッダ右側に選択ファイル名
- チャート上部のツールバー
  - ズームリセット / ツールチップ ON/OFF / 全画面表示 / データ・軸設定
- サイドパネル
  - フィルタ、並び替え、全表示/全非表示
  - グループ単位の表示/非表示・軸割当（Y1/Y2/Y3 チップ）
  - シリーズの軸割当（チップ）
  - 軸レンジ（最小/最大）

## 実装の要点（コード構成）
- 中心ファイル: `src/App.tsx`
  - ファイル読込: `parseCsvFile`, `parseXlsxFile`
  - 正規化: `sanitizeRows`, `toNumeric`, `normalizeExcelString`
  - 日付/時刻解析: `parseDateCell`, `parseTimeCell`, `composeTimestamp`
  - 複数ファイル統合: `annotateDatasetLabels`, `mergeParsedDatasets`
  - グルーピング: `deriveSeriesGroup`, `extractUnit`
  - 測定値特徴: `computeLastValue`, `computeVariability`
  - チャート生成: `useChartData`, `chartOptions`（ズーム/ツールチップ/デシメーション/軸）
  - ツールチップ位置: `Tooltip.positioners.cursorOffset`
- スタイル: `src/App.css`（サイドパネル, チップ, 全画面, グループ表示, バッジ）
- エントリ: `index.html`, `src/main.tsx`
- Netlify: `netlify.toml`

## 既知の仕様/方針
- 外部ツールチップや「ホバー中の線の太字強調」は採用しない
- スタンダードな Chart.js ツールチップを使用（色は系列の境界色に合わせる）
- データ列のデフォルト軸は初回 Y1 に割当

## よくあるトラブルと対処
- CSV が文字化け: Shift_JIS などを自動検出/変換。失敗時はファイルのエンコーディングを確認
- 先頭 `'` 付き時刻で軸が崩れる: 実装済みの正規化で解決済み（`normalizeExcelString`）
- ツールチップが邪魔: 位置決めロジックでカーソルから最遠角へドッキング（通常/全画面）
- 2ファイル目が表示されない: ラベルに `[file]` が付与されているか、フィルタ/非表示設定を確認

## バージョン・リリース
- `package.json` の `version` を更新→右下に `vX.Y.Z` 表示
- リリースノートはコミットメッセージを参照

## ロードマップ/今後の改善候補（メモ）
- プリセット/永続化（表示・軸割当・レンジ・ズームの自動復元、プロファイル保存/切替、JSON Import/Export、ファイル名/装置IDごとの既定プロファイル）
- より柔軟なグループルールの設定 UI（正規表現/単位優先順位）
- 軸設定のテンプレ適用（単位ごとに既定の軸/レンジ）
- 大規模データ向けのさらなる最適化（仮想化 UI、Web Worker パースなど）

## 参考
- 主要設定はすべて `src/App.tsx` にあります。検索キーワード例: `decimation`, `cursorOffset`, `deriveSeriesGroup`, `composeTimestamp`。

---
質問や改善依頼がある場合は、README の該当セクションを参照しつつ、`src/App.tsx` の該当ユーティリティ/オプションから着手すると効率的です。

