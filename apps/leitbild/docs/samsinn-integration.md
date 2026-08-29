# Samsinn Integration

Leitbild exposes a narrow browser protocol for Samsinn iframe screenshot capture and an HTTP command idempotency contract for command commits.

## Screenshot Protocol

Current protocol version: `1.0`.

Samsinn sends requests to the embedded Leitbild window with `postMessage`. Leitbild only accepts messages from `window.parent`, validates the message type, checks the parent origin allow-list, and responds to `event.origin` only.

Request:

```json
{
  "type": "samsinn.screenshot.request",
  "requestId": "screenshot-123"
}
```

Success response:

```json
{
  "type": "samsinn.screenshot.response",
  "requestId": "screenshot-123",
  "protocolVersion": "1.0",
  "dataUrl": "data:image/png;base64,...",
  "width": 1280,
  "height": 720
}
```

Error response:

```json
{
  "type": "samsinn.screenshot.response",
  "requestId": "screenshot-123",
  "protocolVersion": "1.0",
  "error": "capture_failed",
  "message": "map canvas rendered blank pixels"
}
```

Allowed image MIME types are `image/png` and `image/jpeg`. Leitbild captures PNG first, verifies sampled map pixels are non-blank, then downscales if the data URL is larger than `LEITBILD_SCREENSHOT_MAX_DATA_URL_BYTES` (default `5000000`). If downscaled PNG remains too large, Leitbild falls back to JPEG at quality `0.85`. If the final image still exceeds the cap, the response uses `error: "oversized"`.

Screenshot capture is disabled unless `LEITBILD_SCREENSHOT_CAPTURE_ENABLED=true`. When enabled, the MapLibre map is created with `preserveDrawingBuffer: true`; this is creation-time configuration and is not toggled per request.

The parent origin allow-list is configured with `LEITBILD_ALLOWED_PARENT_ORIGINS`, a comma-separated list. The default is:

```text
https://samsinn.app,https://*.samsinn.app
```

Samsinn should use a 3 second timeout for screenshot responses. Leitbild may return `disabled`, `origin_mismatch`, `oversized`, or `capture_failed`.

## Command Idempotency

Command commits accept an optional `idempotencyKey`:

```json
{
  "actorId": "actor:operator",
  "clientId": "client:samsinn",
  "idempotencyKey": "commit-123",
  "kind": "ambulance.set_destination",
  "targetObjectIds": ["ambulance:1", "incident:9"],
  "payload": {
    "ambulanceId": "ambulance:1",
    "destinationId": "incident:9"
  },
  "expectedRevision": 12
}
```

The dedup tuple is:

```text
(controlInstanceId, actorId, clientId|null, kind, idempotencyKey)
```

Leitbild fingerprints `targetObjectIds`, `payload`, and `expectedRevision`. A duplicate with the same tuple and same body replays the original result, including the original `commandId`. Concurrent duplicates share the in-flight command execution. The fixed TTL starts at first-seen and defaults to 1 hour; override it with `LEITBILD_IDEMPOTENCY_TTL_MS`. Each runtime keeps up to `LEITBILD_IDEMPOTENCY_MAX_ENTRIES` entries, default `10000`.

If the same tuple is reused with a different body before expiry, Leitbild returns:

```json
{
  "error": {
    "code": "idempotency_conflict",
    "message": "idempotency key was reused with a different command body"
  }
}
```

with HTTP status `409`.

A replayed success has the same shape as the original command response:

```json
{
  "result": {
    "ok": true,
    "commandId": "command:original",
    "acceptedAt": "2026-05-25T10:00:00.000Z"
  }
}
```
