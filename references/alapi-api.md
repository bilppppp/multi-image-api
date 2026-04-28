# ALAPI gpt-image-2 API Notes

Use this reference only when modifying or debugging the ALAPI provider in this skill.

## Authentication

ALAPI uses a token query parameter:

```text
?token=${ALAPI_TOKEN}
```

Do not put the token in the request body, provider files, prompts, logs, or final replies.

## Text To Image And Reference Images

Endpoint:

```text
POST https://v3.alapi.cn/api/ai/images/generations
```

Request body is JSON:

```json
{
  "model": "gpt-image-2",
  "prompt": "A cat",
  "n": "1",
  "size": "1024x1024",
  "resolution": "1k"
}
```

For reference-image generation, include `image_urls`:

```json
{
  "model": "gpt-image-2",
  "prompt": "Keep the composition, change the style",
  "n": "1",
  "size": "1024x1024",
  "resolution": "1k",
  "image_urls": ["data:image/png;base64,..."]
}
```

`image_urls` supports URLs or base64 image values. The skill sends local files as base64 data URLs.

## Response

The direct endpoint can return image URLs under:

```json
{
  "data": {
    "data": [
      {
        "url": "https://example.com/image.png"
      }
    ]
  }
}
```

The skill also accepts common image arrays such as `data.images`, `result.images`, and `data.result.images`.

## Task Responses

Some ALAPI examples return a task id:

```json
{
  "data": {
    "status": "submitted",
    "task_id": "TASK_ID"
  }
}
```

When a task id is returned, poll:

```text
POST https://v3.alapi.cn/api/ai/images/generations/task?token=${ALAPI_TOKEN}
```

Request body:

```json
{
  "task_id": "TASK_ID"
}
```

## Business Errors

ALAPI may return HTTP 200 with a business failure:

```json
{
  "success": false,
  "code": 10005,
  "message": "接口剩余可用次数不足，请充值"
}
```

Treat `success: false` as a failure even when HTTP status is 200.

