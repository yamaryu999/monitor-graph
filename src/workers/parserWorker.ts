/// <reference lib="webworker" />

import { parseFileInputs, type ParseFileInput, type ParsedDataset } from '../lib/dataParser';

type WorkerRequest = {
  id: string;
  files: ParseFileInput[];
};

type WorkerResponse =
  | { id: string; success: true; payload: ParsedDataset[] }
  | { id: string; success: false; error: string };

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener('message', async (event: MessageEvent<WorkerRequest>) => {
  const { id, files } = event.data;
  try {
    const datasets = await parseFileInputs(files);
    const response: WorkerResponse = { id, success: true, payload: datasets };
    ctx.postMessage(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : '解析に失敗しました。';
    const response: WorkerResponse = { id, success: false, error: message };
    ctx.postMessage(response);
  }
});

export {};
