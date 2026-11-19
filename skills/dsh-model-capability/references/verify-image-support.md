# Verify a model's real image support

The `input: [text, image]` declaration is not a measurement — it is a claim about
the model. DSH trusts it and stops guarding the read-image tool the moment it is
present. So declaring image support on a model that cannot actually see produces
the worst outcome: the model receives an image it cannot interpret and answers
anyway. It will often invent a plausible answer rather than say it cannot see.

Confirm on the wire before you declare. Every check below is cheap.

## Step 1 — does the endpoint advertise anything?

```bash
curl -s -H "Authorization: Bearer $KEY" "$BASE_URL/models" | python3 -m json.tool
```

Self-hosted OpenAI-compatible endpoints (vLLM and friends) typically return only
`id`, `created`, `object`, `owned_by`. No capability field. This tells you
nothing either way, so continue to step 2.

If the endpoint *does* return a modalities/capabilities field, prefer it over
guessing — but still confirm with step 2, because gateways often carry stale
metadata.

## Step 2 — send a real image with known contents

Generate a small test image whose text you control, then ask the model to read it
back. A model that cannot see will either error, return empty content, or
explicitly say it cannot see the image.

```bash
python3 - <<'PY'
from PIL import Image, ImageDraw
im = Image.new("RGB", (300, 120), (255, 255, 255))
d = ImageDraw.Draw(im)
d.rectangle([10, 10, 290, 110], outline=(0, 0, 0), width=3)
d.text((30, 50), "HELLO 42", fill=(0, 0, 0))
im.save("/tmp/t.png")
PY
```

```bash
KEY=$(python3 -c "
import re, os
s = open(os.path.expanduser('~/.dsh/.credentials.yaml')).read()
print(re.search(r'YOUR_KEY_NAME:\s*(\S+)', s).group(1))
")

python3 - "$KEY" <<'PY'
import base64, json, sys, urllib.error, urllib.request
key = sys.argv[1]
b64 = base64.b64encode(open('/tmp/t.png', 'rb').read()).decode()
body = {
    "model": "MODEL_ID_HERE",
    "max_tokens": 60,
    "messages": [{"role": "user", "content": [
        {"type": "text", "text": "What text is written in this image? Answer briefly."},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64," + b64}},
    ]}],
}
req = urllib.request.Request(
    "BASE_URL/chat/completions",
    data=json.dumps(body).encode(),
    headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
)
try:
    d = json.load(urllib.request.urlopen(req, timeout=60))
    print("REPLY:", repr(d["choices"][0]["message"].get("content")))
except urllib.error.HTTPError as e:
    print("HTTP", e.code, e.read().decode()[:300])
PY
```

Note the `data:image/png;base64,` prefix — the endpoint needs a data URL, not raw
base64.

## Step 3 — read the result

| Reply | Meaning | Declare image? |
|---|---|---|
| `'HELLO 42'` (or close) | Model really sees the image | Yes |
| `'\n\nHELLO 42'` | Correct, just leading whitespace | Yes |
| `None` / empty content | Likely no vision; the model emitted nothing | No |
| "I'm unable to see the image…" | Model explicitly reports no vision | No |
| HTTP 400 mentioning image content | Endpoint rejects the image part | No |

Re-run a couple of times before concluding. A transient `None` can come from
token limits rather than missing vision; raise `max_tokens` if the model is a
reasoning variant that spends its budget on thinking before answering.

## Step 4 — declare only what you verified

Add `input: [text, image]` to that model's entry. Leave every model that failed
or that you did not test alone. An undeclared model produces a clear refusal
("model does not declare image input"); a wrongly declared one produces a
confident wrong answer. The first failure is much cheaper to diagnose.

`text` is not optional. A declaration must list every modality the entry accepts
and may only contain `text` and `image` — the schema rejects anything else:

```
$.providers.routes.models[0].input[1] expected "text" | "image" but got "audio"
```

## Step 5 — confirm end to end through DSH

After editing the config and restarting, the read-image tool should stop
refusing. The gate lives in `dsh-tool-fs` and checks the *resolved* route:

```js
const info = await llm.resolveModelInfo(provider, model, signal);
if (!info.inputModalities?.includes("image")) throw new Error(...);
```

To see what DSH actually resolved, dump the composed config:

```bash
dsh --profile <name> --dump-config | sed -n '/- id: llm-pi-ai/,/^- id: /p'
```

The composed output is the ground truth — it reflects every layer, including a
machine-wide patch that may have quietly replaced what you just edited. If your
edit is not in the composed output, something above it won. See
`references/dsh-patch-layers.md` for why.
