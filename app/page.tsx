'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  Download,
  FileArchive,
  ImageIcon,
  LockKeyhole,
  MousePointer2,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';

type Box = { x: number; y: number; w: number; h: number };
type JobState = 'ready' | 'working' | 'done' | 'error';
type ImageJob = {
  id: string;
  file: File;
  url: string;
  width: number;
  height: number;
  state: JobState;
  output?: Blob;
  outputUrl?: string;
};

const MAX_FILES = 30;
const DEFAULT_BOX: Box = { x: 0.66, y: 0.78, w: 0.27, h: 0.12 };

function readableBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function getDimensions(file: File) {
  const bitmap = await createImageBitmap(file);
  const result = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return result;
}

function cleanRegion(ctx: CanvasRenderingContext2D, box: Box, strength: number) {
  const { width, height } = ctx.canvas;
  const x0 = Math.max(1, Math.floor(box.x * width));
  const y0 = Math.max(1, Math.floor(box.y * height));
  const x1 = Math.min(width - 2, Math.ceil((box.x + box.w) * width));
  const y1 = Math.min(height - 2, Math.ceil((box.y + box.h) * height));
  if (x1 <= x0 || y1 <= y0) return;

  const frame = ctx.getImageData(0, 0, width, height);
  const source = new Uint8ClampedArray(frame.data);
  const data = frame.data;
  const sample = (x: number, y: number, channel: number) =>
    source[(Math.max(0, Math.min(height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))) * 4 + channel];
  const commitment = Math.max(0.55, strength / 100);

  for (let y = y0; y <= y1; y++) {
    const ty = (y - y0) / Math.max(1, y1 - y0);
    for (let x = x0; x <= x1; x++) {
      const tx = (x - x0) / Math.max(1, x1 - x0);
      const index = (y * width + x) * 4;
      let horizontalCost = 0;
      let verticalCost = 0;
      for (let c = 0; c < 3; c++) {
        horizontalCost += Math.abs(sample(x0 - 1, y, c) - sample(x1 + 1, y, c));
        verticalCost += Math.abs(sample(x, y0 - 1, c) - sample(x, y1 + 1, c));
      }
      const useHorizontal = horizontalCost <= verticalCost;
      for (let c = 0; c < 3; c++) {
        const horizontal = sample(x0 - 1, y, c) * (1 - tx) + sample(x1 + 1, y, c) * tx;
        const vertical = sample(x, y0 - 1, c) * (1 - ty) + sample(x, y1 + 1, c) * ty;
        const primary = useHorizontal ? horizontal : vertical;
        const secondary = useHorizontal ? vertical : horizontal;
        data[index + c] = primary * commitment + secondary * (1 - commitment);
      }
      data[index + 3] = 255;
    }
  }
  ctx.putImageData(frame, 0, 0);
}

function crc32(bytes: Uint8Array) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}

function u16(value: number) {
  return [value & 255, (value >>> 8) & 255];
}

function u32(value: number) {
  return [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255];
}

async function makeZip(files: { name: string; blob: Blob }[]) {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const body = new Uint8Array(await file.blob.arrayBuffer());
    const crc = crc32(body);
    const local = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(body.length), ...u32(body.length), ...u16(name.length), ...u16(0), ...name,
    ]);
    localParts.push(local, body);
    const central = new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(body.length), ...u32(body.length), ...u16(name.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name,
    ]);
    centralParts.push(central);
    offset += local.length + body.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
    ...u32(centralSize), ...u32(offset), ...u16(0),
  ]);
  return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
}

export default function Home() {
  const [jobs, setJobs] = useState<ImageJob[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [box, setBox] = useState<Box>(DEFAULT_BOX);
  const [confirmed, setConfirmed] = useState(false);
  const [strength, setStrength] = useState(64);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const drawStart = useRef<{ x: number; y: number } | null>(null);
  const urls = useRef<string[]>([]);
  const active = jobs.find((job) => job.id === activeId) ?? jobs[0];
  const completed = jobs.filter((job) => job.state === 'done').length;

  useEffect(() => () => urls.current.forEach((url) => URL.revokeObjectURL(url)), []);

  useEffect(() => {
    const modelContext = (document as Document & {
      modelContext?: {
        registerTool: (tool: unknown, options?: { signal?: AbortSignal }) => void | Promise<void>;
      };
    }).modelContext;
    if (!modelContext?.registerTool) return;
    const lifecycle = new AbortController();
    const tool = {
      name: 'configure_repair_region',
      title: '设置批量修复区域',
      description: '按图片宽高比例设置可见的批量修复选区和边缘保持强度；不会开始处理或绕过授权确认。',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', minimum: 0, maximum: 1 },
          y: { type: 'number', minimum: 0, maximum: 1 },
          width: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
          height: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
          strength: { type: 'integer', minimum: 20, maximum: 100 },
        },
        required: ['x', 'y', 'width', 'height', 'strength'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input: unknown) {
        const value = input as Record<string, unknown>;
        const x = Number(value.x);
        const y = Number(value.y);
        const width = Number(value.width);
        const height = Number(value.height);
        const nextStrength = Number(value.strength);
        if (![x, y, width, height, nextStrength].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1 || nextStrength < 20 || nextStrength > 100) {
          throw new Error('选区必须完全位于图片范围内，强度必须为 20–100。');
        }
        setBox({ x, y, w: width, h: height });
        setStrength(Math.round(nextStrength));
        setNotice('已通过自动化接口更新修复选区。');
        return { configured: true, region: { x, y, width, height }, strength: Math.round(nextStrength) };
      },
    };
    try {
      void Promise.resolve(modelContext.registerTool(tool, { signal: lifecycle.signal })).catch(() => undefined);
    } catch {
      // Browsers without a working WebMCP implementation keep the visible workflow.
    }
    return () => lifecycle.abort();
  }, []);

  const addFiles = useCallback(async (incoming: FileList | File[]) => {
    const files = Array.from(incoming)
      .filter((file) => ['image/jpeg', 'image/png', 'image/webp'].includes(file.type))
      .slice(0, Math.max(0, MAX_FILES - jobs.length));
    if (!files.length) {
      setNotice('请选择 JPG、PNG 或 WebP 图片，单次最多 30 张。');
      return;
    }
    const next: ImageJob[] = [];
    for (const file of files) {
      try {
        const dimensions = await getDimensions(file);
        const url = URL.createObjectURL(file);
        urls.current.push(url);
        next.push({ id: crypto.randomUUID(), file, url, ...dimensions, state: 'ready' });
      } catch {
        // Skip unreadable images.
      }
    }
    setJobs((current) => [...current, ...next]);
    if (!activeId && next[0]) setActiveId(next[0].id);
    setNotice(next.length ? `已加入 ${next.length} 张图片。请在预览中框选需要修复的区域。` : '没有可读取的图片。');
  }, [activeId, jobs.length]);

  const removeJob = (id: string) => {
    setJobs((current) => {
      const target = current.find((job) => job.id === id);
      if (target) {
        URL.revokeObjectURL(target.url);
        if (target.outputUrl) URL.revokeObjectURL(target.outputUrl);
      }
      const next = current.filter((job) => job.id !== id);
      if (activeId === id) setActiveId(next[0]?.id ?? null);
      return next;
    });
  };

  const pointerPosition = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  };

  const processAll = async () => {
    if (!confirmed) {
      setNotice('请先确认你拥有这些图片或已获得处理授权。');
      return;
    }
    if (!jobs.length || box.w < 0.005 || box.h < 0.005) return;
    setBusy(true);
    setProgress(0);
    setNotice('正在本地修复图片，请保持页面开启。');

    for (let index = 0; index < jobs.length; index++) {
      const job = jobs[index];
      setJobs((current) => current.map((item) => item.id === job.id ? { ...item, state: 'working' } : item));
      try {
        const bitmap = await createImageBitmap(job.file);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) throw new Error('Canvas unavailable');
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        cleanRegion(ctx, box, strength);
        const type = job.file.type === 'image/png' ? 'image/png' : job.file.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
        const output = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Export failed')), type, 1),
        );
        const outputUrl = URL.createObjectURL(output);
        urls.current.push(outputUrl);
        setJobs((current) => current.map((item) => item.id === job.id ? { ...item, state: 'done', output, outputUrl } : item));
      } catch {
        setJobs((current) => current.map((item) => item.id === job.id ? { ...item, state: 'error' } : item));
      }
      setProgress(Math.round(((index + 1) / jobs.length) * 100));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    setBusy(false);
    setNotice('批量修复完成。建议先检查预览，再下载结果。');
  };

  const downloadAll = async () => {
    const outputs = jobs.filter((job) => job.output).map((job) => ({ name: `已修复-${job.file.name}`, blob: job.output! }));
    if (!outputs.length) return;
    setNotice('正在打包下载文件…');
    const zip = await makeZip(outputs);
    const url = URL.createObjectURL(zip);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `清印台-批量结果-${new Date().toISOString().slice(0, 10)}.zip`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    setNotice(`已打包 ${outputs.length} 张图片。`);
  };

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-white/8 bg-[#071018]/88 backdrop-blur-xl">
        <div className="mx-auto flex h-18 max-w-[1500px] items-center justify-between px-4 sm:px-7">
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-xl bg-cyan-300 text-[#071018] shadow-[0_0_28px_rgba(103,232,249,.2)]"><Sparkles className="size-5" /></div>
            <div>
              <div className="flex items-center gap-2"><span className="text-lg font-semibold tracking-tight">清印台</span><span className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-2 py-0.5 text-[11px] font-medium text-cyan-200">本地处理</span></div>
              <p className="text-xs text-slate-500">批量图像区域修复</p>
            </div>
          </div>
          <div className="hidden items-center gap-2 text-sm text-slate-400 sm:flex"><LockKeyhole className="size-4 text-emerald-300" />图片不离开浏览器</div>
        </div>
      </header>

      <section className="mx-auto max-w-[1500px] px-4 py-5 sm:px-7 sm:py-7">
        <div className="mb-5 flex flex-col justify-between gap-3 lg:flex-row lg:items-end">
          <div>
            <p className="mb-1 text-sm font-medium text-cyan-300">工作台</p>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">框选一次，批量修复相同位置</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">适合位置一致的自有图片。系统沿四周纹理和轮廓重建遮挡区域，不使用模糊覆盖，并保持原始像素尺寸。</p>
          </div>
          <div className="flex gap-2 text-xs text-slate-400"><span className="rounded-lg border border-white/8 bg-white/[.03] px-3 py-2">最多 30 张</span><span className="rounded-lg border border-white/8 bg-white/[.03] px-3 py-2">JPG · PNG · WebP</span></div>
        </div>

        <div className="workspace-grid">
          <aside className="panel flex min-h-[620px] flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b border-white/8 px-4 py-3">
              <div><h2 className="font-medium">图片队列</h2><p className="mt-0.5 text-xs text-slate-500">{jobs.length}/{MAX_FILES} 张</p></div>
              {jobs.length > 0 && <Button variant="ghost" size="icon" aria-label="清空队列" onClick={() => jobs.forEach((job) => removeJob(job.id))}><Trash2 /></Button>}
            </div>
            <label
              className={`m-3 flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed px-4 py-7 text-center transition ${dragging ? 'border-cyan-300 bg-cyan-300/10' : 'border-white/15 bg-white/[.025] hover:border-cyan-300/55 hover:bg-cyan-300/[.04]'}`}
              onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => { event.preventDefault(); setDragging(false); void addFiles(event.dataTransfer.files); }}
            >
              <input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(event) => event.target.files && void addFiles(event.target.files)} />
              <UploadCloud className="mb-3 size-6 text-cyan-300" />
              <span className="text-sm font-medium">拖入图片或点击选择</span>
              <span className="mt-1 text-xs text-slate-500">仅在当前浏览器中读取</span>
            </label>
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3">
              {jobs.length === 0 ? (
                <div className="grid h-48 place-items-center text-center"><div><ImageIcon className="mx-auto mb-2 size-7 text-slate-600" /><p className="text-sm text-slate-500">等待添加图片</p></div></div>
              ) : jobs.map((job, index) => (
                <div key={job.id} role="button" tabIndex={0} onClick={() => setActiveId(job.id)} onKeyDown={(event) => { if (event.key === 'Enter') setActiveId(job.id); }} className={`group flex w-full cursor-pointer items-center gap-3 rounded-xl p-2 text-left transition ${active?.id === job.id ? 'bg-cyan-300/10 ring-1 ring-inset ring-cyan-300/25' : 'hover:bg-white/[.04]'}`}>
                  <img src={job.outputUrl ?? job.url} alt="" className="size-12 rounded-lg bg-black/30 object-cover" />
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{job.file.name}</span><span className="mt-1 block text-xs text-slate-500">{job.width} × {job.height} · {readableBytes(job.file.size)}</span></span>
                  <span className="grid size-7 place-items-center">
                    {job.state === 'done' ? <Check className="size-4 text-emerald-300" /> : job.state === 'working' ? <span className="size-3 animate-spin rounded-full border-2 border-cyan-300 border-t-transparent" /> : <button aria-label={`移除第 ${index + 1} 张图片`} onClick={(event) => { event.stopPropagation(); removeJob(job.id); }}><X className="size-4 text-slate-600 opacity-0 transition group-hover:opacity-100" /></button>}
                  </span>
                </div>
              ))}
            </div>
          </aside>

          <section className="panel flex min-h-[620px] flex-col overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/8 px-4 py-3">
              <div className="flex items-center gap-2 text-sm text-slate-400"><MousePointer2 className="size-4 text-cyan-300" />在图片上拖动，框选需要修复的区域</div>
              <Button variant="ghost" size="sm" onClick={() => setBox(DEFAULT_BOX)}><RotateCcw />重置选区</Button>
            </div>
            <div className="checkerboard relative flex min-h-[470px] flex-1 items-center justify-center overflow-hidden p-5 sm:p-8">
              {active ? (
                <div
                  className="relative inline-flex max-h-full max-w-full touch-none cursor-crosshair select-none"
                  onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); const p = pointerPosition(event); drawStart.current = p; setBox({ ...p, w: 0, h: 0 }); }}
                  onPointerMove={(event) => { if (!drawStart.current) return; const p = pointerPosition(event); const start = drawStart.current; setBox({ x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) }); }}
                  onPointerUp={() => { drawStart.current = null; }}
                >
                  <img src={active.outputUrl ?? active.url} alt={`当前预览：${active.file.name}`} draggable={false} className="max-h-[68vh] max-w-full rounded-md object-contain shadow-2xl" />
                  <div className="selection-box" style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }}><span>修复区域</span></div>
                </div>
              ) : (
                <div className="max-w-sm text-center"><div className="mx-auto mb-4 grid size-16 place-items-center rounded-2xl border border-white/10 bg-white/[.04]"><ImageIcon className="size-7 text-slate-500" /></div><h3 className="font-medium">先添加一组图片</h3><p className="mt-2 text-sm leading-6 text-slate-500">图片进入队列后，在这里框出水印所在位置。选区会按比例应用到整批图片。</p></div>
              )}
            </div>
            <div className="border-t border-white/8 bg-[#0a151f] px-4 py-3 text-xs text-slate-500">选区：X {Math.round(box.x * 100)}% · Y {Math.round(box.y * 100)}% · 宽 {Math.round(box.w * 100)}% · 高 {Math.round(box.h * 100)}%</div>
          </section>

          <aside className="panel flex min-h-[620px] flex-col">
            <div className="border-b border-white/8 px-4 py-3"><h2 className="font-medium">修复设置</h2><p className="mt-0.5 text-xs text-slate-500">当前设置应用到全部图片</p></div>
            <div className="space-y-6 p-4">
              <div>
                <div className="mb-3 flex items-center justify-between"><label htmlFor="strength" className="text-sm font-medium">边缘保持</label><span className="font-mono text-xs text-cyan-300">{strength}%</span></div>
                <input id="strength" className="accent-slider w-full" type="range" min="20" max="100" value={strength} onChange={(event) => setStrength(Number(event.target.value))} />
                <div className="mt-2 flex justify-between text-[11px] text-slate-600"><span>柔和延伸</span><span>结构优先</span></div>
              </div>

              <div className="rounded-xl border border-white/8 bg-white/[.025] p-3.5">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium"><ShieldCheck className="size-4 text-emerald-300" />使用确认</div>
                <label className="flex cursor-pointer items-start gap-3 text-sm leading-5 text-slate-400">
                  <Checkbox checked={confirmed} onCheckedChange={(checked) => setConfirmed(checked === true)} className="mt-0.5" />
                  <span>我确认拥有这些图片，或已获得编辑和移除标记的明确授权。</span>
                </label>
              </div>

              {busy && <div><div className="mb-2 flex justify-between text-xs text-slate-400"><span>正在处理</span><span>{progress}%</span></div><Progress value={progress} className="[&_[data-slot=progress-indicator]]:bg-cyan-300" /></div>}
              <div aria-live="polite" className="min-h-10 rounded-lg bg-black/20 px-3 py-2.5 text-xs leading-5 text-slate-400">{notice || '准备好后开始批量修复。所有计算都在本机完成。'}</div>
            </div>
            <div className="mt-auto space-y-2 border-t border-white/8 p-4">
              <Button size="lg" className="h-11 w-full bg-cyan-300 font-semibold text-[#071018] hover:bg-cyan-200" disabled={busy || !jobs.length || !confirmed || box.w < 0.005 || box.h < 0.005} onClick={() => void processAll()}><Sparkles />{busy ? `处理中 ${progress}%` : `批量修复 ${jobs.length ? `(${jobs.length})` : ''}`}</Button>
              <Button size="lg" variant="outline" className="h-11 w-full border-white/10 bg-white/[.03]" disabled={busy || completed === 0} onClick={() => void downloadAll()}><FileArchive />下载全部 ZIP {completed > 0 && `(${completed})`}</Button>
              <p className="pt-1 text-center text-[11px] leading-5 text-slate-600"><Download className="mr-1 inline size-3" />保持原始宽高；导出编码可能改变文件大小</p>
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}
