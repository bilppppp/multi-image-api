import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const DEFAULT_BASE_URL = "https://api.tu-zi.com/v1";
const DEFAULT_ALAPI_BASE_URL = "https://v3.alapi.cn/api/ai/images";
const DEFAULT_MODEL = "gpt-image-2";
const DEFAULT_OUTPUT_DIR = "tuzi-output";
const REQUEST_TIMEOUT_MS = 1_800_000;
const MAX_EDIT_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_EDGE = 3840;
const MIN_SHORT_EDGE = 1024;
const SKILL_NAME = "multi-image-api";
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);

type Mode = "generation" | "edit";
type Provider = "tuzi" | "alapi";

export type CliArgs = {
  provider: Provider;
  prompt: string | null;
  output: string | null;
  referenceImages: string[];
  mask: string | null;
  size: string | null;
  aspectRatio: string | null;
  quality: string | null;
  n: number;
  model: string;
  resolution: string;
  json: boolean;
  help: boolean;
  background: boolean;
};

export type RunResult = {
  provider: Provider;
  mode: Mode;
  model: string;
  size: string;
  outputs: string[];
  warnings?: string[];
};

type RunDeps = {
  env?: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
  now?: Date;
  cwd?: string;
};

type SpawnDetached = (command: string, args: string[]) => Promise<number | void> | number | void;

export type JobStatus = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  createdAt: string;
  updatedAt: string;
  cwd: string;
  outputs: string[];
  statusPath: string;
  nextCommand: string;
  args?: CliArgs;
  result?: RunResult;
  error?: string;
  pid?: number;
};

type JobDeps = {
  env?: Record<string, string | undefined>;
  cwd?: string;
  jobsDir?: string;
  now?: Date;
  spawnDetached?: SpawnDetached;
};

type ApiImageResponse = {
  data?: Array<{ url?: string; b64_json?: string }>;
};

type ImageAsset = {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
};

type SharpFactory = typeof import("sharp").default;
let sharpFactory: SharpFactory | null = null;

export type ContentRect = {
  origWidth: number;
  origHeight: number;
  contentX: number;
  contentY: number;
  contentWidth: number;
  contentHeight: number;
  squareSide: number;
};

export type PreparedEditAssets = {
  primaryImage: ImageAsset;
  mask: ImageAsset | null;
  references: ImageAsset[];
  contentRect: ContentRect;
};

type TargetSizeInput = {
  mode: Mode;
  explicitSize?: string | null;
  aspectRatio?: string | null;
  prompt?: string | null;
  inputWidth?: number;
  inputHeight?: number;
};

export type TargetSizeDecision = {
  size: string;
  warnings: string[];
};

function printUsage(): void {
  console.log(`Usage:
  bun scripts/main.ts --provider tuzi --prompt "A 16:9 moon poster" --output out.png --background
  bun scripts/main.ts --provider alapi --prompt "A cat" --output cat.png --background
  bun scripts/main.ts jobs wait --id JOB_ID --timeout 90
  bun scripts/main.ts --prompt "Make the coat blue" --ref source.jpg --output edited.png --background

Options:
  --provider <name>      Provider: tuzi or alapi. Default: tuzi.
  --prompt <text>        Prompt text. Positional text is also accepted.
  --output <path>, -o    Output image path. Default: tuzi-output/tuzi-YYYYMMDD-HHMMSS.png
  --ref <files...>       Reference images. First image is the main edit image.
  --mask <file>          Optional edit mask for the first reference image.
  --size <WxH>           Explicit output size, e.g. 1536x864.
  --ar <ratio>           Aspect ratio, e.g. 16:9, 9:16, 4:3.
  --quality <value>      Tuzi quality value. Image edits default to low.
  --n <count>            Number of images. Default: 1.
  --model <id>           Model. Default: gpt-image-2.
  --resolution <value>   ALAPI resolution: 1k, 2k, or 4k. Default: 1k.
  --background           Start a local background job and return immediately.
  --json                 Print machine-readable result.
  --help, -h             Show this help.

Environment:
  TUZI_API_KEY           Required when --provider tuzi.
  ALAPI_TOKEN            Required when --provider alapi.`);
}

async function getSharp(): Promise<SharpFactory> {
  if (sharpFactory) return sharpFactory;
  try {
    sharpFactory = (await import("sharp")).default;
    return sharpFactory;
  } catch {
    throw new Error("Missing image dependency: run `bun install --frozen-lockfile` in the skill scripts directory.");
  }
}

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    provider: "tuzi",
    prompt: null,
    output: null,
    referenceImages: [],
    mask: null,
    size: null,
    aspectRatio: null,
    quality: null,
    n: 1,
    model: DEFAULT_MODEL,
    resolution: "1k",
    json: false,
    help: false,
    background: false,
  };
  const positional: string[] = [];

  const takeMany = (index: number): { items: string[]; next: number } => {
    const items: string[] = [];
    let next = index + 1;
    while (next < argv.length && !argv[next]!.startsWith("-")) {
      items.push(argv[next]!);
      next += 1;
    }
    return { items, next: next - 1 };
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--json") {
      out.json = true;
      continue;
    }
    if (arg === "--background") {
      out.background = true;
      continue;
    }
    if (arg === "--provider") {
      const value = argv[++i];
      if (!value) throw new Error("Missing value for --provider");
      out.provider = normalizeProvider(value);
      continue;
    }
    if (arg === "--prompt") {
      const value = argv[++i];
      if (!value) throw new Error("Missing value for --prompt");
      out.prompt = value;
      continue;
    }
    if (arg === "--output" || arg === "-o") {
      const value = argv[++i];
      if (!value) throw new Error(`Missing value for ${arg}`);
      out.output = value;
      continue;
    }
    if (arg === "--ref" || arg === "--reference") {
      const { items, next } = takeMany(i);
      if (items.length === 0) throw new Error(`Missing files for ${arg}`);
      out.referenceImages.push(...items);
      i = next;
      continue;
    }
    if (arg === "--mask") {
      const value = argv[++i];
      if (!value) throw new Error("Missing value for --mask");
      out.mask = value;
      continue;
    }
    if (arg === "--size") {
      const value = argv[++i];
      if (!value) throw new Error("Missing value for --size");
      out.size = value;
      continue;
    }
    if (arg === "--ar") {
      const value = argv[++i];
      if (!value) throw new Error("Missing value for --ar");
      out.aspectRatio = value;
      continue;
    }
    if (arg === "--quality") {
      const value = argv[++i];
      if (!value) throw new Error("Missing value for --quality");
      out.quality = value;
      continue;
    }
    if (arg === "--n") {
      const value = argv[++i];
      if (!value) throw new Error("Missing value for --n");
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
        throw new Error("--n must be an integer from 1 to 10");
      }
      out.n = parsed;
      continue;
    }
    if (arg === "--model" || arg === "-m") {
      const value = argv[++i];
      if (!value) throw new Error(`Missing value for ${arg}`);
      out.model = value;
      continue;
    }
    if (arg === "--resolution") {
      const value = argv[++i];
      if (!value) throw new Error("Missing value for --resolution");
      out.resolution = value;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    positional.push(arg);
  }

  if (!out.prompt && positional.length > 0) {
    out.prompt = positional.join(" ");
  }

  return out;
}

function normalizeProvider(value: string): Provider {
  const normalized = value.trim().toLowerCase();
  if (normalized === "tuzi" || normalized === "tu-zi") return "tuzi";
  if (normalized === "alapi") return "alapi";
  throw new Error(`Unsupported provider: ${value}. Use tuzi or alapi.`);
}

export function buildOutputPaths(output: string | null, count: number, now = new Date()): string[] {
  const target = output || path.join(DEFAULT_OUTPUT_DIR, `tuzi-${formatTimestamp(now)}.png`);
  const parsed = path.parse(target);
  const looksLikeDirectory = target.endsWith("/") || target.endsWith(path.sep) || parsed.ext === "";

  if (count === 1) {
    if (looksLikeDirectory) return [path.join(target, `tuzi-${formatTimestamp(now)}.png`)];
    return [target];
  }

  const dir = looksLikeDirectory ? target : parsed.dir;
  const name = looksLikeDirectory ? `tuzi-${formatTimestamp(now)}` : parsed.name;
  const ext = looksLikeDirectory ? ".png" : parsed.ext || ".png";
  return Array.from({ length: count }, (_, index) => path.join(dir, `${name}-${index + 1}${ext}`));
}

function formatTimestamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

export function deriveTargetSize(input: TargetSizeInput): string {
  return deriveTargetSizeDecision(input).size;
}

export function deriveTargetSizeDecision(input: TargetSizeInput): TargetSizeDecision {
  const warnings = deriveSizeWarnings(input);
  const explicit = normalizeExplicitSize(input.explicitSize) || normalizeExplicitSize(input.prompt);
  if (explicit) return { size: explicit, warnings };

  const ratioSource = input.aspectRatio || extractRatioText(input.prompt);
  if (ratioSource) return { size: sizeForRatioText(ratioSource), warnings };

  const direction = extractDirection(input.prompt);
  if (direction === "landscape") return { size: "1536x864", warnings };
  if (direction === "portrait") return { size: "864x1536", warnings };
  if (direction === "square") return { size: "1024x1024", warnings };

  if (
    input.mode === "edit" &&
    input.inputWidth &&
    input.inputHeight &&
    (mentionsSourceRatio(input.prompt) || !input.prompt || input.prompt.trim().length > 0)
  ) {
    return { size: sizeForRatio(input.inputWidth / input.inputHeight), warnings };
  }

  return { size: "1024x1024", warnings };
}

function normalizeExplicitSize(value?: string | null): string | null {
  if (!value) return null;
  const match = value.match(/(\d{3,5})\s*[xX*×]\s*(\d{3,5})/);
  if (!match) return null;
  const width = Number.parseInt(match[1]!, 10);
  const height = Number.parseInt(match[2]!, 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return `${width}x${height}`;
}

function extractRatioText(prompt?: string | null): string | null {
  if (!prompt) return null;
  const match = prompt.match(/(\d+(?:\.\d+)?)\s*[:：]\s*(\d+(?:\.\d+)?)/);
  return match ? `${match[1]}:${match[2]}` : null;
}

function extractDirection(prompt?: string | null): "landscape" | "portrait" | "square" | null {
  if (!prompt) return null;
  const lower = prompt.toLowerCase();
  if (/横版|横幅|横图|landscape/.test(lower)) return "landscape";
  if (/竖版|竖幅|竖图|portrait/.test(lower)) return "portrait";
  if (/方图|方形|square/.test(lower)) return "square";
  return null;
}

function deriveSizeWarnings(input: TargetSizeInput): string[] {
  const warnings: string[] = [];
  const promptRatio = extractRatioText(input.prompt);
  const ratioSource = input.aspectRatio || promptRatio;
  const explicit = normalizeExplicitSize(input.explicitSize) || normalizeExplicitSize(input.prompt);
  const directionInfo = extractDirectionInfo(input.prompt);

  if (input.aspectRatio && promptRatio && normalizeRatioText(input.aspectRatio) !== normalizeRatioText(promptRatio)) {
    warnings.push(`Both --ar ${input.aspectRatio} and prompt ratio ${promptRatio} were provided; using --ar.`);
  }

  if (explicit && (ratioSource || directionInfo.landscape || directionInfo.portrait || directionInfo.square)) {
    warnings.push(`Explicit size ${explicit} overrides ratio or direction words in the prompt.`);
    return warnings;
  }

  if (ratioSource) {
    const orientation = orientationForRatioText(ratioSource);
    if (orientation === "landscape" && directionInfo.portrait && !directionInfo.landscape) {
      warnings.push(`Ratio ${ratioSource} is landscape but the prompt says portrait/vertical; using the explicit ratio.`);
    }
    if (orientation === "portrait" && directionInfo.landscape && !directionInfo.portrait) {
      warnings.push(`Ratio ${ratioSource} is portrait but the prompt says landscape/horizontal; using the explicit ratio.`);
    }
  } else if (directionInfo.landscape && directionInfo.portrait) {
    warnings.push("Prompt contains both landscape/horizontal and portrait/vertical words; using landscape direction.");
  }

  return warnings;
}

function extractDirectionInfo(prompt?: string | null): {
  landscape: boolean;
  portrait: boolean;
  square: boolean;
} {
  const lower = (prompt || "").toLowerCase();
  return {
    landscape: /横版|横幅|横图|landscape/.test(lower),
    portrait: /竖版|竖幅|竖图|portrait/.test(lower),
    square: /方图|方形|square/.test(lower),
  };
}

function normalizeRatioText(value: string): string {
  const [left, right] = value.split(":");
  const width = Number.parseFloat(left || "");
  const height = Number.parseFloat(right || "");
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return value.trim();
  }
  return `${trimRatioNumber(width)}:${trimRatioNumber(height)}`;
}

function orientationForRatioText(value: string): "landscape" | "portrait" | "square" | null {
  const [left, right] = value.split(":");
  const width = Number.parseFloat(left || "");
  const height = Number.parseFloat(right || "");
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  if (Math.abs(width - height) < 0.01) return "square";
  return width > height ? "landscape" : "portrait";
}

function mentionsSourceRatio(prompt?: string | null): boolean {
  if (!prompt) return false;
  return /保持原图比例|参考原图比例|按原图比例/.test(prompt);
}

function sizeForRatioText(value: string): string {
  const [left, right] = value.split(":");
  const width = Number.parseFloat(left || "");
  const height = Number.parseFloat(right || "");
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return "1024x1024";
  }

  const normalized = `${trimRatioNumber(width)}:${trimRatioNumber(height)}`;
  const common: Record<string, string> = {
    "1:1": "1024x1024",
    "3:2": "1536x1024",
    "2:3": "1024x1536",
    "4:3": "1536x1152",
    "3:4": "1152x1536",
    "16:9": "1536x864",
    "9:16": "864x1536",
    "2:1": "2048x1024",
    "1:2": "1024x2048",
    "21:9": "1344x576",
    "9:21": "576x1344",
    "3:1": "3072x1024",
    "1:3": "1024x3072",
  };
  return common[normalized] || sizeForRatio(width / height);
}

function trimRatioNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value).replace(/\.0+$/, "");
}

function sizeForRatio(rawRatio: number): string {
  if (!Number.isFinite(rawRatio) || rawRatio <= 0) return "1024x1024";
  const commonByRatio: Array<[number, string]> = [
    [1, "1024x1024"],
    [3 / 2, "1536x1024"],
    [2 / 3, "1024x1536"],
    [4 / 3, "1536x1152"],
    [3 / 4, "1152x1536"],
    [16 / 9, "1536x864"],
    [9 / 16, "864x1536"],
    [2, "2048x1024"],
    [1 / 2, "1024x2048"],
    [21 / 9, "1344x576"],
    [9 / 21, "576x1344"],
    [3, "3072x1024"],
    [1 / 3, "1024x3072"],
  ];
  for (const [ratio, size] of commonByRatio) {
    if (Math.abs(rawRatio - ratio) < 0.02) return size;
  }

  const ratio = Math.min(Math.max(rawRatio, 1 / 3), 3);
  if (Math.abs(ratio - 1) < 0.01) return "1024x1024";

  if (ratio > 1) {
    const shortEdge = MIN_SHORT_EDGE;
    const longEdge = clamp(roundToMultiple(shortEdge * ratio, 16), shortEdge, MAX_EDGE);
    return `${longEdge}x${shortEdge}`;
  }

  const shortEdge = MIN_SHORT_EDGE;
  const longEdge = clamp(roundToMultiple(shortEdge / ratio, 16), shortEdge, MAX_EDGE);
  return `${shortEdge}x${longEdge}`;
}

function roundToMultiple(value: number, multiple: number): number {
  return Math.max(multiple, Math.round(value / multiple) * multiple);
}

function roundUpToMultiple(value: number, multiple: number): number {
  return Math.max(multiple, Math.ceil(value / multiple) * multiple);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function resolveRunCwd(input: { cwd?: string; scriptDir?: string; oldpwd?: string } = {}): string {
  const cwd = path.resolve(input.cwd || process.cwd());
  const scriptDir = path.resolve(input.scriptDir || SCRIPT_DIR);
  const oldpwd = input.oldpwd;
  if (cwd === scriptDir && oldpwd && path.resolve(oldpwd) !== cwd) {
    return path.resolve(oldpwd);
  }
  return cwd;
}

function makeAbsoluteOutputs(outputs: string[], cwd: string): string[] {
  return outputs.map((output) => (path.isAbsolute(output) ? output : path.join(cwd, output)));
}

function makeAbsoluteOutputArg(output: string | null, cwd: string, now = new Date()): string {
  const target = output || path.join(DEFAULT_OUTPUT_DIR, `tuzi-${formatTimestamp(now)}.png`);
  return path.isAbsolute(target) ? target : path.join(cwd, target);
}

function defaultJobsDir(): string {
  return path.join(homedir(), `.${SKILL_NAME}`, "jobs");
}

function jobStatusPath(id: string, jobsDir = defaultJobsDir()): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid job id.");
  return path.join(jobsDir, `${id}.json`);
}

function makeJobId(now = new Date()): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${formatTimestamp(now)}-${random}`;
}

function shellQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function jobWaitCommand(id: string): string {
  return `bun ${shellQuote(SCRIPT_PATH)} jobs wait --id ${id} --timeout 90`;
}

async function writeJobStatus(status: JobStatus): Promise<void> {
  await mkdir(path.dirname(status.statusPath), { recursive: true });
  await writeFile(status.statusPath, `${JSON.stringify(status, null, 2)}\n`);
}

export async function readJobStatus(id: string, jobsDir = defaultJobsDir()): Promise<JobStatus> {
  return JSON.parse(await readFile(jobStatusPath(id, jobsDir), "utf8")) as JobStatus;
}

export async function startBackgroundJob(args: CliArgs, deps: JobDeps = {}): Promise<JobStatus> {
  const env = deps.env || process.env;
  getProviderApiKey(args.provider, env);
  if (!args.prompt || args.prompt.trim().length === 0) {
    throw new Error("Prompt is required. Pass --prompt or positional prompt text.");
  }

  const now = deps.now || new Date();
  const id = makeJobId(now);
  const jobsDir = deps.jobsDir || env.MULTI_IMAGE_API_JOBS_DIR || defaultJobsDir();
  const cwd = deps.cwd || resolveRunCwd({ oldpwd: env.OLDPWD });
  const storedArgs: CliArgs = {
    ...args,
    background: false,
    output: makeAbsoluteOutputArg(args.output, cwd, now),
  };
  const outputs = makeAbsoluteOutputs(buildOutputPaths(storedArgs.output, args.n, now), cwd);
  const statusPath = jobStatusPath(id, jobsDir);
  const status: JobStatus = {
    id,
    status: "queued",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    cwd,
    outputs,
    statusPath,
    nextCommand: jobWaitCommand(id),
    args: storedArgs,
  };
  await writeJobStatus(status);

  const spawnDetached = deps.spawnDetached || defaultSpawnDetached;
  const pid = await spawnDetached(process.execPath, [SCRIPT_PATH, "--worker-job", id]);
  if (typeof pid === "number") {
    status.pid = pid;
    status.updatedAt = new Date().toISOString();
    await writeJobStatus(status);
  }

  return status;
}

async function defaultSpawnDetached(command: string, args: string[]): Promise<number | void> {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, MULTI_IMAGE_API_JOBS_DIR: process.env.MULTI_IMAGE_API_JOBS_DIR || defaultJobsDir() },
  });
  child.unref();
  return child.pid;
}

export async function runWorkerJob(id: string, deps: JobDeps & RunDeps = {}): Promise<JobStatus> {
  const env = deps.env || process.env;
  const jobsDir = deps.jobsDir || env.MULTI_IMAGE_API_JOBS_DIR || defaultJobsDir();
  const current = await readJobStatus(id, jobsDir);
  const running: JobStatus = {
    ...current,
    status: "running",
    updatedAt: new Date().toISOString(),
  };
  await writeJobStatus(running);

  try {
    if (!running.args) throw new Error("Job file is missing generation arguments.");
    const result = await runGeneration(running.args, {
      env,
      fetch: deps.fetch,
      now: deps.now,
      cwd: running.cwd,
    });
    const succeeded: JobStatus = {
      ...running,
      status: "succeeded",
      updatedAt: new Date().toISOString(),
      outputs: result.outputs,
      result,
      nextCommand: "",
    };
    await writeJobStatus(succeeded);
    return succeeded;
  } catch (error) {
    const failed: JobStatus = {
      ...running,
      status: "failed",
      updatedAt: new Date().toISOString(),
      error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
    };
    await writeJobStatus(failed);
    return failed;
  }
}

export async function waitForJob(
  id: string,
  options: { jobsDir?: string; timeoutMs?: number; intervalMs?: number } = {}
): Promise<JobStatus> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const intervalMs = options.intervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  let latest = await readJobStatus(id, options.jobsDir);
  while ((latest.status === "queued" || latest.status === "running") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    latest = await readJobStatus(id, options.jobsDir);
  }
  return latest;
}

export async function runGeneration(args: CliArgs, deps: RunDeps = {}): Promise<RunResult> {
  if (args.help) {
    printUsage();
    return { provider: args.provider, mode: "generation", model: normalizeModel(args.model), size: "1024x1024", outputs: [] };
  }

  const env = deps.env || process.env;
  const apiKey = getProviderApiKey(args.provider, env);
  if (!args.prompt || args.prompt.trim().length === 0) {
    throw new Error("Prompt is required. Pass --prompt or positional prompt text.");
  }
  await getSharp();

  const fetcher = deps.fetch || globalThis.fetch;
  const baseURL = getProviderBaseUrl(args.provider, env);
  const model = normalizeModel(args.model);
  const mode: Mode = args.referenceImages.length > 0 ? "edit" : "generation";
  if (args.provider === "alapi" && args.n > 4) {
    throw new Error("ALAPI supports --n from 1 to 4.");
  }

  let inputWidth: number | undefined;
  let inputHeight: number | undefined;
  if (mode === "edit") {
    const sharp = await getSharp();
    const metadata = await sharp(args.referenceImages[0]!).metadata();
    inputWidth = metadata.width;
    inputHeight = metadata.height;
    if (!inputWidth || !inputHeight) {
      throw new Error("Could not read the first reference image dimensions.");
    }
  }

  const sizeDecision = deriveTargetSizeDecision({
    mode,
    explicitSize: args.size,
    aspectRatio: args.aspectRatio,
    prompt: args.prompt,
    inputWidth,
    inputHeight,
  });
  const size = sizeDecision.size;

  const images =
    args.provider === "alapi"
      ? await requestAlapiImages(baseURL, apiKey, args, model, size, fetcher)
      : mode === "edit"
        ? await requestEditImages(baseURL, apiKey, args, model, size, fetcher)
        : await requestGeneratedImages(baseURL, apiKey, args, model, size, fetcher);

  const runCwd = deps.cwd || resolveRunCwd({ oldpwd: env.OLDPWD });
  const outputs = makeAbsoluteOutputs(buildOutputPaths(args.output, images.length, deps.now), runCwd);
  await saveImages(images, outputs);
  return {
    provider: args.provider,
    mode,
    model,
    size,
    outputs,
    ...(sizeDecision.warnings.length > 0 ? { warnings: sizeDecision.warnings } : {}),
  };
}

function getProviderApiKey(provider: Provider, env: Record<string, string | undefined>): string {
  if (provider === "alapi") {
    if (!env.ALAPI_TOKEN) {
      throw new Error("ALAPI_TOKEN is required. Set it in your environment before using ALAPI.");
    }
    return env.ALAPI_TOKEN;
  }
  if (!env.TUZI_API_KEY) {
    throw new Error("TUZI_API_KEY is required. Set it in your environment before using Tuzi.");
  }
  return env.TUZI_API_KEY;
}

function getProviderBaseUrl(provider: Provider, env: Record<string, string | undefined>): string {
  const baseURL = provider === "alapi" ? env.ALAPI_BASE_URL || DEFAULT_ALAPI_BASE_URL : env.TUZI_BASE_URL || DEFAULT_BASE_URL;
  return baseURL.replace(/\/+$/, "");
}

function normalizeModel(model: string): string {
  return model.replace(/^openai\//, "") || DEFAULT_MODEL;
}

async function requestGeneratedImages(
  baseURL: string,
  apiKey: string,
  args: CliArgs,
  model: string,
  size: string,
  fetcher: typeof globalThis.fetch
): Promise<Uint8Array[]> {
  const body: Record<string, unknown> = {
    model,
    prompt: args.prompt,
    size,
    n: args.n,
    response_format: "url",
  };
  if (args.quality) body.quality = args.quality;

  const response = await fetchWithTimeout(fetcher, `${baseURL}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  await assertOk(response, "Tuzi image generation failed");
  return extractImagesFromResponse((await response.json()) as ApiImageResponse, fetcher);
}

async function requestEditImages(
  baseURL: string,
  apiKey: string,
  args: CliArgs,
  model: string,
  size: string,
  fetcher: typeof globalThis.fetch
): Promise<Uint8Array[]> {
  const assets = await prepareEditAssets(args.referenceImages, args.mask);
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", args.prompt!);
  form.append("size", size);
  form.append("n", String(args.n));
  form.append("quality", args.quality || "low");
  form.append("response_format", "url");
  form.append("image", new Blob([assets.primaryImage.bytes], { type: assets.primaryImage.mimeType }), assets.primaryImage.filename);
  if (assets.mask) {
    form.append("mask", new Blob([assets.mask.bytes], { type: assets.mask.mimeType }), assets.mask.filename);
  }
  for (const ref of assets.references) {
    form.append("image", new Blob([ref.bytes], { type: ref.mimeType }), ref.filename);
  }

  const response = await fetchWithTimeout(fetcher, `${baseURL}/images/edits`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });
  await assertOk(response, "Tuzi image edit failed");
  return extractImagesFromResponse((await response.json()) as ApiImageResponse, fetcher);
}

async function requestAlapiImages(
  baseURL: string,
  apiKey: string,
  args: CliArgs,
  model: string,
  size: string,
  fetcher: typeof globalThis.fetch
): Promise<Uint8Array[]> {
  const url = new URL(`${baseURL}/generations`);
  url.searchParams.set("token", apiKey);

  const body: Record<string, unknown> = {
    model,
    prompt: args.prompt,
    n: String(args.n),
    size,
    resolution: args.resolution || "1k",
  };
  if (args.referenceImages.length > 0) {
    body.image_urls = await Promise.all(args.referenceImages.map((imagePath) => fileToAlapiImageUrl(imagePath)));
  }

  const response = await fetchWithTimeout(fetcher, url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  await assertOk(response, "ALAPI image generation failed");
  const payload = (await response.json()) as unknown;
  assertProviderBusinessOk(payload, "ALAPI image generation failed");

  const directItems = getImageItems(payload);
  if (directItems.length > 0) {
    return extractImagesFromResponse({ data: directItems }, fetcher, "ALAPI");
  }

  const taskId = extractTaskId(payload);
  if (taskId) {
    return pollAlapiTask(baseURL, apiKey, taskId, fetcher);
  }

  throw new Error("ALAPI response did not include image data or task_id.");
}

async function fileToAlapiImageUrl(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  return `data:${getMimeType(filePath)};base64,${Buffer.from(bytes).toString("base64")}`;
}

async function pollAlapiTask(
  baseURL: string,
  apiKey: string,
  taskId: string,
  fetcher: typeof globalThis.fetch
): Promise<Uint8Array[]> {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  let lastStatus = "submitted";
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const url = new URL(`${baseURL}/generations/task`);
    url.searchParams.set("token", apiKey);
    const response = await fetchWithTimeout(fetcher, url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ task_id: taskId }),
    });
    await assertOk(response, "ALAPI task query failed");
    const payload = (await response.json()) as unknown;
    assertProviderBusinessOk(payload, "ALAPI task query failed");
    lastStatus = extractStatus(payload) || lastStatus;

    const items = getImageItems(payload);
    if (items.length > 0) {
      return extractImagesFromResponse({ data: items }, fetcher, "ALAPI");
    }
    if (/fail|error|cancel/i.test(lastStatus)) {
      throw new Error(`ALAPI task failed: ${lastStatus}`);
    }
  }
  throw new Error(`ALAPI task timed out before images were ready. Last status: ${lastStatus}`);
}

async function fetchWithTimeout(
  fetcher: typeof globalThis.fetch,
  url: string,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(url, { ...init, signal: init.signal || controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function assertOk(response: Response, message: string): Promise<void> {
  if (response.ok) return;
  const text = await response.text().catch(() => "");
  const detail = redactSensitiveText(text);
  throw new Error(`${message}: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
}

function assertProviderBusinessOk(payload: unknown, message: string): void {
  if (!isRecord(payload)) return;
  if (payload.success === false) {
    const code = typeof payload.code === "number" || typeof payload.code === "string" ? ` code ${payload.code}` : "";
    const detail = typeof payload.message === "string" ? ` ${payload.message}` : "";
    throw new Error(redactSensitiveText(`${message}:${code}${detail}`));
  }
  const data = payload.data;
  if (isRecord(data) && data.success === false) {
    const code = typeof data.code === "number" || typeof data.code === "string" ? ` code ${data.code}` : "";
    const detail = typeof data.message === "string" ? ` ${data.message}` : "";
    throw new Error(redactSensitiveText(`${message}:${code}${detail}`));
  }
}

export function redactSensitiveText(input: string): string {
  return input
    .replace(
      /(^|[^A-Za-z0-9_])(["']?(?:TUZI_API_KEY|ALAPI_TOKEN|OPENAI_API_KEY|api[_-]?key|apikey|secret|token|key)["']?\s*[:=]\s*)(["']?)([^"',\s}&]+)/gi,
      (_match, prefix: string, label: string, quote: string) => `${prefix}${label}${quote}[redacted]`
    )
    .replace(/Bearer\s+[^\s"',}]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\bghp_[A-Za-z0-9_]{8,}\b/g, "[redacted]");
}

export async function extractImagesFromResponse(
  result: ApiImageResponse | unknown,
  fetcher: typeof globalThis.fetch,
  providerLabel = "image",
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<Uint8Array[]> {
  const data = getImageItems(result);
  if (data.length === 0) throw new Error(`${providerLabel} response did not include image data.`);

  const images: Uint8Array[] = [];
  for (const item of data) {
    if (item.b64_json) {
      images.push(Uint8Array.from(Buffer.from(item.b64_json, "base64")));
      continue;
    }
    if (item.url) {
      const response = await fetchWithTimeout(fetcher, item.url, {}, timeoutMs);
      await assertOk(response, `Failed to download ${providerLabel} image result`);
      images.push(new Uint8Array(await response.arrayBuffer()));
      continue;
    }
    throw new Error(`${providerLabel} image item did not include url or b64_json.`);
  }
  return images;
}

function getImageItems(result: unknown): Array<{ url?: string; b64_json?: string }> {
  const items: Array<{ url?: string; b64_json?: string }> = [];
  const visitArray = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (!isRecord(item)) continue;
      const url = typeof item.url === "string" ? item.url : typeof item.image_url === "string" ? item.image_url : undefined;
      const b64_json =
        typeof item.b64_json === "string"
          ? item.b64_json
          : typeof item.base64 === "string"
            ? item.base64
            : typeof item.image_base64 === "string"
              ? item.image_base64
              : undefined;
      if (url || b64_json) items.push({ url, b64_json });
    }
  };

  if (!isRecord(result)) return items;
  visitArray(result.data);
  if (isRecord(result.data)) {
    visitArray(result.data.data);
    visitArray(result.data.images);
    if (isRecord(result.data.result)) visitArray(result.data.result.images);
  }
  visitArray(result.images);
  if (isRecord(result.result)) visitArray(result.result.images);
  return items;
}

function extractTaskId(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.task_id === "string") return payload.task_id;
  if (typeof payload.taskId === "string") return payload.taskId;
  if (isRecord(payload.data)) {
    if (typeof payload.data.task_id === "string") return payload.data.task_id;
    if (typeof payload.data.taskId === "string") return payload.data.taskId;
  }
  return null;
}

function extractStatus(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.status === "string") return payload.status;
  if (isRecord(payload.data) && typeof payload.data.status === "string") return payload.data.status;
  if (isRecord(payload.result) && typeof payload.result.status === "string") return payload.result.status;
  if (isRecord(payload.data) && isRecord(payload.data.result) && typeof payload.data.result.status === "string") {
    return payload.data.result.status;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function saveImages(images: Uint8Array[], outputs: string[]): Promise<void> {
  for (let i = 0; i < images.length; i += 1) {
    const output = outputs[i]!;
    await mkdir(path.dirname(output), { recursive: true });
    const normalized = await normalizeFinalImage(images[i]!);
    await writeFile(output, normalized);
  }
}

async function normalizeFinalImage(bytes: Uint8Array): Promise<Buffer> {
  try {
    const sharp = await getSharp();
    return await sharp(bytes).flatten({ background: "#ffffff" }).png().toBuffer();
  } catch {
    return Buffer.from(bytes);
  }
}

export async function prepareEditAssets(referenceImages: string[], maskPath: string | null): Promise<PreparedEditAssets> {
  if (referenceImages.length === 0) {
    throw new Error("At least one reference image is required for image edits.");
  }

  const primaryPath = referenceImages[0]!;
  const primaryBytes = await readFile(primaryPath);
  const sharp = await getSharp();
  const metadata = await sharp(primaryBytes).metadata();
  const origWidth = metadata.width;
  const origHeight = metadata.height;
  if (!origWidth || !origHeight) {
    throw new Error("Could not read primary image dimensions.");
  }

  const candidates = squareSideCandidates(origWidth, origHeight);
  let selected: { image: Buffer; mask: Buffer; contentRect: ContentRect } | null = null;
  let lastSize = 0;
  for (const side of candidates) {
    const contentRect = computeContentRect(origWidth, origHeight, side);
    const image = await makeSquareImage(primaryBytes, contentRect);
    const mask = maskPath
      ? await makeSquareImage(await readFile(maskPath), contentRect)
      : await makeAutoMask(contentRect);
    lastSize = Math.max(image.byteLength, mask.byteLength);
    if (image.byteLength < MAX_EDIT_IMAGE_BYTES && mask.byteLength < MAX_EDIT_IMAGE_BYTES) {
      selected = { image, mask, contentRect };
      break;
    }
  }

  if (!selected) {
    throw new Error(`Could not prepare edit image under 4MB. Smallest PNG was ${lastSize} bytes.`);
  }

  const references: ImageAsset[] = [];
  for (const refPath of referenceImages.slice(1)) {
    references.push({
      bytes: new Uint8Array(await readFile(refPath)),
      filename: path.basename(refPath),
      mimeType: getMimeType(refPath),
    });
  }

  return {
    primaryImage: {
      bytes: new Uint8Array(selected.image),
      filename: "tuzi-primary.png",
      mimeType: "image/png",
    },
    mask: {
      bytes: new Uint8Array(selected.mask),
      filename: "tuzi-mask.png",
      mimeType: "image/png",
    },
    references,
    contentRect: selected.contentRect,
  };
}

function squareSideCandidates(width: number, height: number): number[] {
  const ideal = clamp(roundUpToMultiple(Math.max(width, height, MIN_SHORT_EDGE), 16), MIN_SHORT_EDGE, MAX_EDGE);
  const fallback = [3840, 3584, 3328, 3072, 2816, 2560, 2304, 2048, 1792, 1536, 1280, 1152, 1024];
  return Array.from(new Set([ideal, ...fallback.filter((side) => side <= ideal)])).sort((a, b) => b - a);
}

function computeContentRect(origWidth: number, origHeight: number, squareSide: number): ContentRect {
  const scale = Math.min(squareSide / origWidth, squareSide / origHeight);
  const contentWidth = clamp(roundToMultiple(origWidth * scale, 1), 1, squareSide);
  const contentHeight = clamp(roundToMultiple(origHeight * scale, 1), 1, squareSide);
  const contentX = Math.floor((squareSide - contentWidth) / 2);
  const contentY = Math.floor((squareSide - contentHeight) / 2);
  return { origWidth, origHeight, contentX, contentY, contentWidth, contentHeight, squareSide };
}

async function makeSquareImage(input: Uint8Array, rect: ContentRect): Promise<Buffer> {
  const sharp = await getSharp();
  const resized = await sharp(input)
    .rotate()
    .resize(rect.contentWidth, rect.contentHeight, { fit: "fill" })
    .ensureAlpha()
    .png({ compressionLevel: 9 })
    .toBuffer();
  return sharp({
    create: {
      width: rect.squareSide,
      height: rect.squareSide,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    },
  })
    .composite([{ input: resized, left: rect.contentX, top: rect.contentY }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function makeAutoMask(rect: ContentRect): Promise<Buffer> {
  const sharp = await getSharp();
  const transparentEditArea = await sharp({
    create: {
      width: rect.contentWidth,
      height: rect.contentHeight,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    },
  })
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: rect.squareSide,
      height: rect.squareSide,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite([{ input: transparentEditArea, left: rect.contentX, top: rect.contentY }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".avif") return "image/avif";
  return "image/png";
}

if (import.meta.main) {
  try {
    const rawArgs = Bun.argv.slice(2);
    if (rawArgs[0] === "--worker-job") {
      const id = rawArgs[1];
      if (!id) throw new Error("Missing worker job id.");
      await runWorkerJob(id);
      process.exit(0);
    }

    if (rawArgs[0] === "jobs") {
      const command = rawArgs[1];
      const id = getOption(rawArgs, "--id");
      if (!id) throw new Error("Missing --id.");
      const jobsDir = process.env.MULTI_IMAGE_API_JOBS_DIR || defaultJobsDir();
      const timeoutSeconds = Number.parseInt(getOption(rawArgs, "--timeout") || "90", 10);
      const status =
        command === "wait"
          ? await waitForJob(id, { jobsDir, timeoutMs: Math.max(1, timeoutSeconds) * 1000 })
          : await readJobStatus(id, jobsDir);
      console.log(JSON.stringify(status, null, 2));
      process.exit(status.status === "failed" ? 1 : 0);
    }

    const args = parseArgs(rawArgs);
    if (args.help) {
      printUsage();
      process.exit(0);
    }
    if (args.background) {
      const status = await startBackgroundJob(args);
      console.log(JSON.stringify(status, null, 2));
      process.exit(0);
    }
    const result = await runGeneration(args);
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Saved ${result.outputs.length} image${result.outputs.length === 1 ? "" : "s"}:`);
      for (const output of result.outputs) console.log(output);
      if (result.warnings?.length) {
        console.log("Warnings:");
        for (const warning of result.warnings) console.log(`- ${warning}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(redactSensitiveText(message));
    process.exit(1);
  }
}

function getOption(argv: string[], option: string): string | null {
  const index = argv.indexOf(option);
  return index === -1 ? null : argv[index + 1] || null;
}
