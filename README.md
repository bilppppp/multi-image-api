# Multi Image API Skill

一个给 AI agent 使用的图片生成 skill。它把第三方图片 API 的调用、图片下载、参考图处理、长时间任务等待这些细节封装起来，让用户只需要准备 API key，再用自然语言描述想要的图片。

当前版本已实现 Tuzi 和 ALAPI 的 `gpt-image-2` 文生图能力；两者都支持传入参考图。Tuzi 使用图片编辑接口，ALAPI 使用 `image_urls` 参考图方式。

## 功能

- 文生图：输入提示词，生成图片并保存到本地。
- 图生图：传入参考图，自动走图片编辑流程。
- 多参考图：第一张是主图，后续图片作为参考图。
- 自动处理图片：普通截图、非方图、透明 PNG、大图会被处理成更适合接口的格式。
- 后台任务：适合 opencode、Codex 等 agent，避免图片生成时间太长导致命令超时。
- 服务商选择：默认使用 Tuzi，也可以通过 `--provider alapi` 使用 ALAPI。
- 安全处理 key：只读取环境变量，不把 key 写进文件或结果里。

## 准备工作

需要安装：

- Bun
- Tuzi API key 或 ALAPI token

根据服务商设置环境变量：

```bash
export TUZI_API_KEY="你的 Tuzi API key"
# 或
export ALAPI_TOKEN="你的 ALAPI token"
```

不要把 API key 写进提示词，也不要直接粘贴给 AI agent。

## 安装

克隆仓库：

```bash
git clone https://github.com/bilppppp/multi-image-api.git
cd multi-image-api/scripts
bun install --frozen-lockfile
```

## 使用示例

文生图：

```bash
bun scripts/main.ts --prompt "9:16 竖幅海报，月下古风美女在直播间跳舞，唯美清冷" --ar 9:16 --output poster.png --background
```

使用 ALAPI：

```bash
bun scripts/main.ts --provider alapi --prompt "1:1 方图，一只白色小猫坐在月光下，水彩插画风格" --output cat.png --background
```

图生图：

```bash
bun scripts/main.ts --prompt "保持构图，把整体风格改成水彩插画" --ref source.png --output edited.png --background
```

查询后台任务：

```bash
bun scripts/main.ts jobs wait --id JOB_ID --timeout 90
```

## 常用参数

| 参数 | 说明 |
| --- | --- |
| `--provider` | 服务商，支持 `tuzi` 和 `alapi`，默认 `tuzi` |
| `--prompt` | 图片提示词 |
| `--output` | 输出文件路径 |
| `--ref` | 参考图路径；有参考图时自动走图生图 |
| `--mask` | 可选 mask 图片 |
| `--size` | 明确尺寸，例如 `1536x864` |
| `--ar` | 图片比例，例如 `16:9`、`9:16`、`1:1` |
| `--quality` | 质量参数；图生图默认 `low` |
| `--n` | 生成数量；ALAPI 最多 4 张 |
| `--resolution` | ALAPI 分辨率，支持 `1k`、`2k`、`4k`，默认 `1k` |
| `--background` | 后台生成，推荐给 AI agent 使用 |
| `--json` | 输出机器可读结果 |

## 给 AI Agent 看的如何安装

当用户要求安装这个 skill 时，按下面流程执行。

1. 选择 skill 目录。

Codex 常用目录：

```bash
mkdir -p ~/.codex/skills
git clone https://github.com/bilppppp/multi-image-api.git ~/.codex/skills/multi-image-api
```

opencode 常用目录：

```bash
mkdir -p ~/.config/opencode/skills
git clone https://github.com/bilppppp/multi-image-api.git ~/.config/opencode/skills/multi-image-api
```

如果目标目录已存在，先不要删除用户文件。进入目录后执行 `git pull` 更新。

2. 安装脚本依赖。

```bash
cd <skill目录>/scripts
bun install --frozen-lockfile
```

3. 确认 key。

根据用户选择的服务商检查环境变量：

```bash
test -n "$TUZI_API_KEY" && echo "TUZI_API_KEY is set"
test -n "$ALAPI_TOKEN" && echo "ALAPI_TOKEN is set"
```

如果用户选择 Tuzi，需要 `TUZI_API_KEY`。如果用户选择 ALAPI，需要 `ALAPI_TOKEN`。没有设置时，停止并请用户在 agent 看不到完整命令的地方设置环境变量。不要让用户把 key 粘贴到聊天里。

4. 调用时优先使用后台模式。

```bash
bun <skill目录>/scripts/main.ts --provider tuzi --prompt "A cat" --output "$(pwd)/cat.png" --background
```

ALAPI 示例：

```bash
bun <skill目录>/scripts/main.ts --provider alapi --prompt "A cat" --output "$(pwd)/cat.png" --background
```

命令会返回 `id` 和下一条查询命令。继续执行：

```bash
bun <skill目录>/scripts/main.ts jobs wait --id JOB_ID --timeout 90
```

重复查询，直到状态是 `succeeded` 或 `failed`。

5. 不要因为命令等待时间长就换用别的图片工具。

图片生成可能需要几分钟。shell 超时不代表接口失败。应先查询后台任务状态，或检查输出文件是否已经生成。

## 测试

```bash
cd scripts
bun run check
```

## 安全说明

- 不要把 API key 写进仓库。
- 不要把 API key 写进命令行参数。
- 不要在最终回复里显示完整 API key。
- 如果 key 已经出现在聊天、日志或截图里，建议立即作废并重新生成。
