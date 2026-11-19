---
name: dsh-model-capability
description: "Diagnose and fix DSH (DeepSeek Harness) model configurations where a model's input capabilities are missing or wrong — especially the 'model does not declare image input' refusal from the read-image tool, and cases where a model genuinely supports images but DSH still refuses. Also covers editing DSH provider/model config so the change survives upgrades and does not silently break other profiles. Use this skill whenever the user asks whether a model supports images, hits 'does not declare image input' / 'does not support image input' when reading a screenshot or picture, wonders why a vision-capable model is treated as text-only, wants to add or change providers/models in DSH, edits cordis.patch.yml or $DSH_HOME config, or asks how to configure DSH so an upgrade will not overwrite it — even if they do not name DSH explicitly but are clearly working under ~/.dsh."
---

# DSH model capability & config

DSH decides whether a model can accept an image from an **explicit declaration in
its config**, not from what the model can actually do. The endpoint's `/v1/models`
reply carries no capability metadata, so nothing auto-detects vision. A model that
reads images perfectly will still be refused until its entry says
`input: [text, image]`.

That single fact explains the whole class of bug this skill handles.

## Diagnose first, edit second

Run the bundled inspector before changing anything:

```bash
python3 scripts/dsh_capability.py
```

It answers four questions at once:

- which provider routes each profile serves, and how many models declare image
- which vision-plausible models are missing an image declaration
- whether one route key carries different baseURLs across profiles (a
  machine-wide patch here will erase all but one profile's version)
- whether a profile declares a route that its composed config no longer contains
  (something higher up overwrote it)

Add `--profile NAME` to narrow it, `--json` for machine-readable output. Exit
code 1 means it found candidates; 2 means it could not inspect.

**Then check the composed config before editing anything.** The composed output
is what DSH actually resolves, and an earlier layer may already declare the
capability you were about to add:

```bash
dsh --profile <name> --dump-config | sed -n '/- id: llm-pi-ai/,/^- id: /p'
```

A user hitting the refusal while their composed config already says
`input: [text, image]` is not a config problem at all. The likely causes are a
long-running process that started before the declaration existed (route
resolution is not hot-reloaded — restart it), or a *different* profile serving
that request. Adding a redundant declaration to a third layer makes the config
worse and hides the real cause.

## The refusal, explained

The read-image tool guards itself before touching the file
(`dsh-tool-fs`, `assertImageCapableRoute`):

```js
const info = await llm.resolveModelInfo(provider, model, signal);
if (!info.inputModalities?.includes("image"))
  throw new Error(`... model "${model}" does not declare image input ...`);
```

`inputModalities` comes from the model entry's `input` field. The pi-ai adapter
resolves it through three fallbacks (`dsh-llm-pi-ai`, `resolveEntry`):

```js
input: declaredInput(entry.input) ?? base?.input ?? [...request.defaultInput]
```

1. `entry.input` — what your config wrote
2. `base?.input` — the installed pi-ai catalog, **keyed by the route name**
3. `request.defaultInput` — the fallback, which is `["text"]`

The middle fallback is the subtle one. The catalog is indexed by route id
(`deepseek`, `openrouter`, `…` — 41 shipped routes). A self-hosted route named
anything else — `zhichu-huawei`, `huawei`, `my-vllm` — misses it entirely and
lands on text-only. So on a custom route, only option 1 works: write the
declaration yourself.

Confirm the model truly reads images before declaring it. `references/verify-image-support.md`
has a ready-to-run end-to-end check. The distinction matters because a model that
cannot see will often answer confidently anyway, and a wrong declaration removes
the guard that would have caught it — whereas an undeclared model fails loudly
and cheaply.

## Editing the config

Read `references/dsh-patch-layers.md` before writing any patch. The two facts that
cause the most damage:

- **A patch replaces the target's whole `config`, never merges it.** Changing one
  model's `input` means writing out every provider and model you want to keep. A
  partial config silently drops the rest.
- **The home layer (`$DSH_HOME/cordis.patch.yml`) applies to every profile.** It
  outranks profile layers and is never written by DSH, so it survives upgrades —
  but an edit meant for one profile replaces that entry's config in all of them.

For a change that is not identical across every profile, prefer that profile's own
layer. Then verify with the composed dump, which runs the same patch algorithm the
boot uses:

```bash
dsh --profile <name> --dump-config | sed -n '/- id: llm-pi-ai/,/^- id: /p'
```

For a home-layer edit, check every profile — `dsh_capability.py` does this and
reports masked routes.

## Reporting back

State what you verified versus what you assumed. Specifically:

- The refusal message quotes a **declaration**, not the model's ability — say which
  it is, because the user will reasonably assume DSH detected the model correctly.
- Only claim a model supports images if you sent it a real image and read back
  known contents. Report the actual reply.
- Never declare image support for a model that failed the check or that you did
  not test. `glm-5.3` returning empty content and `deepseek-v4-flash` saying it
  cannot see the image are both "no".
- When you edit config, report which layer you wrote to and what else that layer
  reaches.
- If the composed config was already correct, say so and give the alternative
  explanation instead of applying a redundant edit.
- Flag what you could not check. `desktop` cannot be inspected over the CLI
  (`dsh --profile desktop --dump-config` refuses: managed exclusively by the
  Electron application), so any claim about it is inference, not measurement.
  Say which claims are which.

## Cross-profile damage is the failure to watch for

A home-layer patch that replaces `llm-pi-ai` will overwrite that entry's provider
map in every profile, silently. Real damage observed in practice: one profile's
provider route replacing another's, dropping models, and flipping a route's
`api` from `openai-responses` to `openai-completions` — with no error, and with
the affected profile's `agent-default-model` left pointing at a route that no
longer exists. That turns into the very refusal this skill is about, in an
unrelated job.

So after ANY config edit, compose every profile and compare. The inspector's
`masked_routes` section does exactly this; run it again after editing.

## Scripts

- `scripts/dsh_capability.py` — per-profile route inventory, missing image
  declarations, cross-profile collisions, masked routes.

## References

- `references/verify-image-support.md` — prove a model reads images, on the wire.
- `references/dsh-patch-layers.md` — layer order, patch semantics, blast radius,
  and what to check when a patch appears to do nothing.
