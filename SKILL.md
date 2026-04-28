---
name: multi-image-api
description: Use when generating or editing images through supported third-party image APIs, including Tuzi and ALAPI, with text-to-image prompts, image-to-image edits, reference images, provider selection, and aspect ratios.
---

# Multi Image API

Generate and edit images with supported third-party image APIs. Tuzi is the default provider; ALAPI is also supported through `--provider alapi`. Use the bundled CLI so API keys, request shape, image preprocessing, downloads, and output files are handled consistently.

## Quick Start

Resolve the skill directory as `SKILL_DIR`. Before first use, install the bundled script dependencies if `scripts/node_modules` is missing:

```bash
cd ${SKILL_DIR}/scripts && bun install --frozen-lockfile
```

Then run:

```bash
bun ${SKILL_DIR}/scripts/main.ts --provider tuzi --prompt "16:9 cinematic moonlit garden" --output "$(pwd)/moon.png" --background
```

If `bun` is unavailable, use:

```bash
npx -y bun ${SKILL_DIR}/scripts/main.ts --prompt "A cat" --output "$(pwd)/cat.png" --background
```

## Authentication

Require the selected provider key in the environment:

- Tuzi: `TUZI_API_KEY`
- ALAPI: `ALAPI_TOKEN`

Do not write keys into prompts, files, logs, or final replies.
Do not prefix commands with `TUZI_API_KEY=...` or `ALAPI_TOKEN=...`; agent tools and terminal transcripts may display full command lines.
If the key is not already available in the shell environment, stop and ask the user to set it outside the agent-visible command before running the script. Do not ask the user to paste the key into the chat. If a key appears in chat or logs, tell the user to rotate it.

```bash
bun ${SKILL_DIR}/scripts/main.ts --provider alapi --prompt "A cat" --output "$(pwd)/cat.png" --background
```

## Agent-Safe Job Workflow

Image requests can exceed common agent shell limits such as 120 seconds. For opencode and other agents, always use background mode:

```bash
bun ${SKILL_DIR}/scripts/main.ts --provider tuzi --prompt "9:16 poster, moonlit dancer" --ar 9:16 --output "$(pwd)/poster.png" --background
```

The command returns JSON with an `id`, `outputs`, and `nextCommand`. Poll with the returned command:

```bash
bun ${SKILL_DIR}/scripts/main.ts jobs wait --id JOB_ID --timeout 90
```

Repeat `jobs wait` until `status` is `succeeded` or `failed`. With `jq`:

```bash
bun ${SKILL_DIR}/scripts/main.ts jobs wait --id JOB_ID --timeout 90 | jq -r '.status, .outputs[]?'
```

Do not switch to another image skill or provider unless the user explicitly asks. A timeout from the shell runner means the foreground command was killed; it does not prove the image API failed.

## Common Commands

```bash
# Text to image
bun ${SKILL_DIR}/scripts/main.ts --provider tuzi --prompt "9:16 poster, moonlit dancer" --output "$(pwd)/poster.png" --background

# Image edit: first --ref image is the main image, later images are references
bun ${SKILL_DIR}/scripts/main.ts --provider tuzi --prompt "Keep the composition, change the coat to blue" --ref source.jpg --output "$(pwd)/edited.png" --background

# Multiple references
bun ${SKILL_DIR}/scripts/main.ts --provider alapi --prompt "Combine the style of the second image into the first" --ref main.jpg style.png --output "$(pwd)/result.png" --background

# Explicit size or ratio
bun ${SKILL_DIR}/scripts/main.ts --prompt "wide banner" --ar 2:1 --output "$(pwd)/banner.png" --background
bun ${SKILL_DIR}/scripts/main.ts --provider alapi --prompt "cover art" --size 1536x864 --output "$(pwd)/cover.png" --background

# Foreground mode only when the shell can wait up to 30 minutes
bun ${SKILL_DIR}/scripts/main.ts --prompt "A cat" --output "$(pwd)/cat.png" --json
```

## Options

| Option | Purpose |
| --- | --- |
| `--provider <tuzi\|alapi>` | Provider to use. Default is `tuzi`. |
| `--prompt <text>` | Prompt text. Positional prompt text also works. |
| `--output <path>`, `-o` | Output path. Default is `tuzi-output/tuzi-YYYYMMDD-HHMMSS.png`. |
| `--ref <files...>` | Reference images. If present, the request uses image edit mode. |
| `--mask <file>` | Optional mask for the first reference image. |
| `--size <WxH>` | Explicit output size; overrides ratio and direction words. |
| `--ar <ratio>` | Aspect ratio such as `16:9`, `9:16`, `4:3`, `2:1`. |
| `--quality <value>` | Tuzi quality value. Edit mode defaults to `low`. |
| `--n <count>` | Number of images, 1 to 10. |
| `--model <id>` | Model override. Default: `gpt-image-2`. |
| `--resolution <1k\|2k\|4k>` | ALAPI resolution. Default: `1k`. |
| `--background` | Start a local job and return immediately; recommended for agents. |
| `--json` | Print machine-readable result. |

Job commands:

```bash
bun ${SKILL_DIR}/scripts/main.ts jobs status --id JOB_ID
bun ${SKILL_DIR}/scripts/main.ts jobs wait --id JOB_ID --timeout 90
```

## Behavior

- Tuzi without `--ref`: call `/v1/images/generations` with JSON.
- Tuzi with `--ref`: call `/v1/images/edits` with multipart form data.
- ALAPI calls `/api/ai/images/generations` with JSON. When `--ref` is present, local files are sent through `image_urls` as base64 data URLs.
- Responses may contain `data[].url` or `data[].b64_json`; the script saves the final image files.
- The first edit image is converted to a square PNG under 4 MB, with a matching mask. Later reference images are uploaded as additional `image` fields.
- Transparent output is flattened onto white and saved as PNG.
- ALAPI accepts at most `--n 4`.
- Request timeout is 30 minutes to allow slow image jobs.
- If an agent runs from the skill's `scripts` directory by mistake, relative outputs are resolved against the previous working directory when available. Prefer absolute outputs with `$(pwd)/file.png`.

## Size Rules

Explicit `--size` or prompt sizes like `1536x864` win. Otherwise, ratio text from `--ar` or the prompt is used.

Common mappings:

| Ratio | Size |
| --- | --- |
| `1:1` | `1024x1024` |
| `16:9` | `1536x864` |
| `9:16` | `864x1536` |
| `4:3` | `1536x1152` |
| `3:2` | `1536x1024` |
| `2:1` | `2048x1024` |

Direction words are used only when no explicit size or ratio exists: landscape -> `1536x864`, portrait -> `864x1536`, square -> `1024x1024`.

For image edits with no requested size or ratio, keep the first image's aspect ratio.

## References

Read `references/tuzi-api.md` only when modifying the Tuzi provider or debugging Tuzi API request details.
Read `references/alapi-api.md` only when modifying the ALAPI provider or debugging ALAPI API request details.
