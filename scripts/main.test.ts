import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import {
  buildOutputPaths,
  readJobStatus,
  resolveRunCwd,
  deriveTargetSize,
  deriveTargetSizeDecision,
  extractImagesFromResponse,
  parseArgs,
  prepareEditAssets,
  redactSensitiveText,
  runGeneration,
  startBackgroundJob,
} from "./main";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "multi-image-api-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("CLI parsing and output paths", () => {
  test("requires TUZI_API_KEY without exposing secrets", async () => {
    const args = parseArgs(["--prompt", "cat"]);
    await expect(
      runGeneration(args, { env: {}, fetch: fetch as typeof globalThis.fetch })
    ).rejects.toThrow("TUZI_API_KEY");
  });

  test("parses ALAPI provider and requires ALAPI_TOKEN", async () => {
    const args = parseArgs(["--provider", "alapi", "--prompt", "cat"]);
    expect(args.provider).toBe("alapi");
    await expect(
      runGeneration(args, { env: {}, fetch: fetch as typeof globalThis.fetch })
    ).rejects.toThrow("ALAPI_TOKEN");
  });

  test("builds default and multi-image output paths", () => {
    const now = new Date("2026-04-28T09:10:11Z");
    expect(buildOutputPaths(null, 1, now)).toEqual(["tuzi-output/tuzi-20260428-091011.png"]);
    expect(buildOutputPaths("out/result.png", 3, now)).toEqual([
      "out/result-1.png",
      "out/result-2.png",
      "out/result-3.png",
    ]);
  });

  test("uses previous working directory when agent accidentally runs from scripts directory", () => {
    const oldpwd = "/Users/gravity/work";
    expect(resolveRunCwd({ cwd: "/tmp/skill/scripts", scriptDir: "/tmp/skill/scripts", oldpwd })).toBe(oldpwd);
    expect(resolveRunCwd({ cwd: "/Users/gravity/work", scriptDir: "/tmp/skill/scripts", oldpwd })).toBe("/Users/gravity/work");
  });

  test("saves relative output under the resolved run directory", async () => {
    const dir = await makeTempDir();
    const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: "white" } }).png().toBuffer();
    const fakeFetch: typeof globalThis.fetch = async (url) => {
      if (String(url).endsWith("/images/generations")) {
        return Response.json({ data: [{ url: "https://example.test/generated.png" }] });
      }
      return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
    };

    const result = await runGeneration(parseArgs(["--prompt", "cat", "--output", "relative.png"]), {
      env: { TUZI_API_KEY: "test-key" },
      fetch: fakeFetch,
      cwd: dir,
    });

    expect(result.outputs).toEqual([join(dir, "relative.png")]);
    expect((await stat(join(dir, "relative.png"))).size).toBeGreaterThan(0);
  });
});

describe("ALAPI requests", () => {
  test("sends text-to-image as JSON with query token and saves downloaded image", async () => {
    const dir = await makeTempDir();
    const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: "white" } }).png().toBuffer();
    const requests: Array<{ url: string; init?: RequestInit }> = [];

    const fakeFetch: typeof globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).startsWith("https://v3.alapi.cn/api/ai/images/generations?")) {
        return Response.json({ data: { data: [{ url: "https://example.test/alapi.png" }] } });
      }
      return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
    };

    const result = await runGeneration(
      parseArgs(["--provider", "alapi", "--prompt", "1:1 moon cat", "--output", join(dir, "alapi.png")]),
      { env: { ALAPI_TOKEN: "alapi-token" }, fetch: fakeFetch }
    );

    const requestUrl = new URL(requests[0]!.url);
    expect(result.provider).toBe("alapi");
    expect(result.mode).toBe("generation");
    expect(requestUrl.origin + requestUrl.pathname).toBe("https://v3.alapi.cn/api/ai/images/generations");
    expect(requestUrl.searchParams.get("token")).toBe("alapi-token");
    expect((requests[0]!.init!.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(JSON.parse(String(requests[0]!.init!.body))).toMatchObject({
      model: "gpt-image-2",
      prompt: "1:1 moon cat",
      n: "1",
      size: "1024x1024",
      resolution: "1k",
    });
    expect((await stat(join(dir, "alapi.png"))).size).toBeGreaterThan(0);
  });

  test("sends local reference images to ALAPI as image_urls", async () => {
    const dir = await makeTempDir();
    const ref = join(dir, "ref.png");
    const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: "white" } }).png().toBuffer();
    await sharp({ create: { width: 1200, height: 800, channels: 3, background: "red" } }).png().toFile(ref);
    let body: Record<string, unknown> = {};

    const fakeFetch: typeof globalThis.fetch = async (url, init) => {
      if (String(url).startsWith("https://v3.alapi.cn/api/ai/images/generations?")) {
        body = JSON.parse(String(init?.body));
        return Response.json({ data: { data: [{ url: "https://example.test/alapi-edit.png" }] } });
      }
      return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
    };

    const result = await runGeneration(
      parseArgs(["--provider", "alapi", "--prompt", "保持原图比例，改成水彩", "--ref", ref, "--output", join(dir, "edit.png")]),
      { env: { ALAPI_TOKEN: "alapi-token" }, fetch: fakeFetch }
    );

    expect(result.provider).toBe("alapi");
    expect(result.mode).toBe("edit");
    expect(result.size).toBe("1536x1024");
    expect(Array.isArray(body.image_urls)).toBe(true);
    expect((body.image_urls as string[])[0]).toMatch(/^data:image\/png;base64,/);
  });

  test("reports ALAPI business errors", async () => {
    const fakeFetch: typeof globalThis.fetch = async () =>
      Response.json({ success: false, code: 10005, message: "接口剩余可用次数不足，请充值" });

    await expect(
      runGeneration(parseArgs(["--provider", "alapi", "--prompt", "cat"]), {
        env: { ALAPI_TOKEN: "alapi-token" },
        fetch: fakeFetch,
      })
    ).rejects.toThrow("10005");
  });
});

describe("background jobs", () => {
  test("starts a detached job with absolute outputs and no stored API key", async () => {
    const dir = await makeTempDir();
    const jobsDir = join(dir, "jobs");
    const spawned: string[][] = [];

    const status = await startBackgroundJob(parseArgs(["--prompt", "cat", "--output", "out.png"]), {
      env: { TUZI_API_KEY: "secret-token" },
      cwd: dir,
      jobsDir,
      now: new Date("2026-04-28T09:10:11Z"),
      spawnDetached: async (command, args) => {
        spawned.push([command, ...args]);
        return 1234;
      },
    });

    expect(status.status).toBe("queued");
    expect(status.outputs).toEqual([join(dir, "out.png")]);
    expect(status.nextCommand).toContain("jobs wait");
    expect(spawned[0]!.join(" ")).toContain("--worker-job");

    const rawStatus = await readFile(status.statusPath, "utf8");
    expect(rawStatus).not.toContain("secret-token");
    expect(await readJobStatus(status.id, jobsDir)).toMatchObject({ id: status.id, status: "queued" });
  });

  test("starts an ALAPI background job without storing the token", async () => {
    const dir = await makeTempDir();
    const jobsDir = join(dir, "jobs");

    const status = await startBackgroundJob(parseArgs(["--provider", "alapi", "--prompt", "cat", "--output", "out.png"]), {
      env: { ALAPI_TOKEN: "alapi-secret-token" },
      cwd: dir,
      jobsDir,
      now: new Date("2026-04-28T09:10:11Z"),
      spawnDetached: async () => 4321,
    });

    expect(status.args?.provider).toBe("alapi");
    const rawStatus = await readFile(status.statusPath, "utf8");
    expect(rawStatus).not.toContain("alapi-secret-token");
  });
});

describe("size derivation", () => {
  test("explicit size wins over ratio and prompt direction", () => {
    expect(
      deriveTargetSize({
        mode: "generation",
        explicitSize: "2048x1024",
        aspectRatio: "16:9",
        prompt: "竖版海报",
      })
    ).toBe("2048x1024");
  });

  test("maps common ratios precisely", () => {
    expect(deriveTargetSize({ mode: "generation", prompt: "16:9 横版电影海报" })).toBe("1536x864");
    expect(deriveTargetSize({ mode: "generation", prompt: "9:16 竖幅封面" })).toBe("864x1536");
    expect(deriveTargetSize({ mode: "generation", prompt: "4:3 复古插画" })).toBe("1536x1152");
    expect(deriveTargetSize({ mode: "generation", prompt: "3:2 摄影作品" })).toBe("1536x1024");
    expect(deriveTargetSize({ mode: "generation", prompt: "2:1 横幅" })).toBe("2048x1024");
  });

  test("warns when explicit ratios conflict with direction words", () => {
    expect(deriveTargetSizeDecision({ mode: "generation", prompt: "16:9 竖幅海报" })).toMatchObject({
      size: "1536x864",
      warnings: [expect.stringContaining("landscape")],
    });
    expect(deriveTargetSizeDecision({ mode: "generation", prompt: "9:16 横幅海报" })).toMatchObject({
      size: "864x1536",
      warnings: [expect.stringContaining("portrait")],
    });
    expect(deriveTargetSizeDecision({ mode: "generation", prompt: "竖版海报", aspectRatio: "16:9" })).toMatchObject({
      size: "1536x864",
      warnings: [expect.stringContaining("landscape")],
    });
  });

  test("warns when explicit size overrides ratio and direction words", () => {
    expect(deriveTargetSizeDecision({ mode: "generation", prompt: "2048x1024 9:16 竖幅" })).toMatchObject({
      size: "2048x1024",
      warnings: [expect.stringContaining("Explicit size")],
    });
  });

  test("keeps source ratio by default for image edits", () => {
    expect(deriveTargetSize({ mode: "edit", prompt: "换成蓝色", inputWidth: 1536, inputHeight: 1024 })).toBe("1536x1024");
    expect(deriveTargetSize({ mode: "edit", prompt: "保持原图比例", inputWidth: 1200, inputHeight: 900 })).toBe("1536x1152");
  });
});

describe("response extraction", () => {
  test("prefers b64_json and downloads URL results", async () => {
    const png = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 1 },
      },
    }).png().toBuffer();

    const calls: string[] = [];
    const fakeFetch: typeof globalThis.fetch = async (url) => {
      calls.push(String(url));
      return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
    };

    const images = await extractImagesFromResponse(
      {
        data: [
          { b64_json: Buffer.from(png).toString("base64"), url: "https://example.test/ignored.png" },
          { url: "https://example.test/image.png" },
        ],
      },
      fakeFetch
    );

    expect(images).toHaveLength(2);
    expect(calls).toEqual(["https://example.test/image.png"]);
    expect(images[0]!.byteLength).toBe(png.byteLength);
  });
});

describe("Tuzi requests", () => {
  test("redacts secrets from API error bodies", async () => {
    const secret = "sk-testsecret1234567890";
    const fakeFetch: typeof globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: {
            key: secret,
            api_key: secret,
            token: "plain-token",
            message: `invalid authorization Bearer ${secret}`,
          },
        }),
        { status: 401 }
      );

    let message = "";
    try {
      await runGeneration(parseArgs(["--prompt", "cat"]), {
        env: { TUZI_API_KEY: secret },
        fetch: fakeFetch,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("[redacted]");
    expect(message).not.toContain(secret);
    expect(message).not.toContain("plain-token");
  });

  test("redacts secrets in standalone text", () => {
    const secret = "sk-testsecret1234567890";
    const redacted = redactSensitiveText(`TUZI_API_KEY="${secret}" {"api_key":"${secret}"} Bearer ${secret}`);
    expect(redacted).not.toContain(secret);
    expect(redacted).toContain('TUZI_API_KEY="[redacted]"');
    expect(redacted).toContain('"api_key":"[redacted]"');
    expect(redacted).toContain("Bearer [redacted]");
    expect(redacted).toContain("[redacted]");
  });

  test("sends text-to-image as JSON and saves downloaded image", async () => {
    const dir = await makeTempDir();
    const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: "white" } }).png().toBuffer();
    const requests: Array<{ url: string; init?: RequestInit }> = [];

    const fakeFetch: typeof globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/images/generations")) {
        return Response.json({ data: [{ url: "https://example.test/generated.png" }] });
      }
      return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
    };

    const result = await runGeneration(
      parseArgs(["--prompt", "16:9 moon poster", "--output", join(dir, "image.png")]),
      { env: { TUZI_API_KEY: "test-key" }, fetch: fakeFetch }
    );

    expect(result.mode).toBe("generation");
    expect(result.size).toBe("1536x864");
    expect(result.outputs).toEqual([join(dir, "image.png")]);
    expect(requests[0]!.url).toBe("https://api.tu-zi.com/v1/images/generations");
    expect((requests[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(JSON.parse(String(requests[0]!.init!.body))).toMatchObject({
      model: "gpt-image-2",
      prompt: "16:9 moon poster",
      size: "1536x864",
      response_format: "url",
    });
    expect((await stat(join(dir, "image.png"))).size).toBeGreaterThan(0);
  });

  test("sends image edits as multipart with repeated image fields and low quality default", async () => {
    const dir = await makeTempDir();
    const main = join(dir, "main.jpg");
    const ref = join(dir, "ref.png");
    const png = await sharp({ create: { width: 32, height: 32, channels: 4, background: "white" } }).png().toBuffer();
    await sharp({ create: { width: 1200, height: 800, channels: 3, background: "red" } }).jpeg().toFile(main);
    await sharp({ create: { width: 100, height: 100, channels: 4, background: "blue" } }).png().toFile(ref);

    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch: typeof globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/images/edits")) {
        return Response.json({ data: [{ url: "https://example.test/edited.png" }] });
      }
      return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
    };

    const result = await runGeneration(
      parseArgs(["--prompt", "保持原图比例，换成蓝色", "--ref", main, ref, "--output", join(dir, "edit.png")]),
      { env: { TUZI_API_KEY: "test-key" }, fetch: fakeFetch }
    );

    expect(result.mode).toBe("edit");
    expect(result.size).toBe("1536x1024");
    const form = requests[0]!.init!.body as FormData;
    const imageFields = form.getAll("image");
    expect(requests[0]!.url).toBe("https://api.tu-zi.com/v1/images/edits");
    expect(imageFields).toHaveLength(2);
    expect(form.get("model")).toBe("gpt-image-2");
    expect(form.get("size")).toBe("1536x1024");
    expect(form.get("quality")).toBe("low");
    expect(form.get("response_format")).toBe("url");
    expect(form.get("mask")).toBeInstanceOf(Blob);
  });
});

describe("image preprocessing", () => {
  test("normalizes the first edit image and mask to matching square PNGs under 4MB", async () => {
    const dir = await makeTempDir();
    const input = join(dir, "wide.jpg");
    await sharp({ create: { width: 1536, height: 1024, channels: 3, background: "green" } }).jpeg().toFile(input);

    const assets = await prepareEditAssets([input], null);
    const mainMeta = await sharp(assets.primaryImage.bytes).metadata();
    const maskMeta = await sharp(assets.mask!.bytes).metadata();

    expect(mainMeta.format).toBe("png");
    expect(mainMeta.width).toBe(mainMeta.height);
    expect(maskMeta.width).toBe(mainMeta.width);
    expect(maskMeta.height).toBe(mainMeta.height);
    expect(assets.primaryImage.bytes.byteLength).toBeLessThan(4 * 1024 * 1024);
    expect(assets.mask!.bytes.byteLength).toBeLessThan(4 * 1024 * 1024);
    expect(assets.contentRect.contentWidth).toBeGreaterThan(assets.contentRect.contentHeight);
  });

  test("flattens transparent downloaded edit output onto white", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, "out"), { recursive: true });
    const transparent = await sharp({
      create: {
        width: 10,
        height: 10,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    }).png().toBuffer();

    const fakeFetch: typeof globalThis.fetch = async (url) => {
      if (String(url).endsWith("/images/generations")) {
        return Response.json({ data: [{ b64_json: Buffer.from(transparent).toString("base64") }] });
      }
      throw new Error("unexpected fetch");
    };

    const output = join(dir, "out", "flat.png");
    await runGeneration(parseArgs(["--prompt", "square", "--output", output]), {
      env: { TUZI_API_KEY: "test-key" },
      fetch: fakeFetch,
    });

    const pixel = await sharp(await readFile(output)).raw().toBuffer();
    expect(Array.from(pixel.slice(0, 3))).toEqual([255, 255, 255]);
  });
});
