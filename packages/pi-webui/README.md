# pi-webui

Local browser UI for a running `pi-server`.

```bash
npm run dev -w packages/pi-webui
```

Defaults:

- Web UI: `http://127.0.0.1:4227`
- pi-server target: `http://127.0.0.1:4217`

Optional environment:

- `PI_WEBUI_HOST`
- `PI_WEBUI_PORT`
- `PI_SERVER_URL`
- `PI_SERVER_AUTH_TOKEN`

Continuing a session requires an explicit model JSON object. The UI does not infer provider configuration from stored messages.
