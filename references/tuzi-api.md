# Tuzi API Reference

Base URL: `https://api.tu-zi.com/v1`

Authentication: `Authorization: Bearer ${TUZI_API_KEY}`

Default model: `gpt-image-2`

## Text to Image

Endpoint: `POST /images/generations`

Content type: `application/json`

Required fields:

- `model`
- `prompt`

Skill defaults:

- `response_format: "url"`
- `n: 1`
- `size`: resolved locally from explicit size, ratio, direction, or `1024x1024`
- Timeout: 1800000 ms

Response forms:

- `data[].url`
- `data[].b64_json`

## Image Edit

Endpoint: `POST /images/edits`

Content type: `multipart/form-data`

Required fields:

- `image`
- `prompt`

Skill defaults:

- `model: "gpt-image-2"`
- `response_format: "url"`
- `quality: "low"`
- `n: 1`
- Timeout: 1800000 ms

Field rules:

- Use repeated `image` fields, not `image[]`.
- The first `image` is the main edit image.
- The first image is normalized to square PNG, under 4 MB, with alpha.
- `mask` is a square PNG under 4 MB and the same dimensions as the first image.
- Later images are reference images and are uploaded as additional `image` fields.
- `size` is the final desired output size, not the square upload size.

## Mask Rule

Tuzi follows the OpenAI edit convention: transparent mask areas indicate regions to edit. The script generates an automatic mask with transparent original-content area and opaque padding area.

## Output Handling

The API often returns image URLs. The script downloads URL results, also supports `b64_json`, then saves PNG outputs. If the downloaded image has transparency, it is flattened onto white before saving to avoid black previews.
