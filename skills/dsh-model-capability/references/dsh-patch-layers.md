# DSH patch layers: what wins, what gets lost

Read this before editing any DSH config. The failure mode here is silent: DSH will
happily accept your edit and then discard it, or discard a *different* profile's
config, with no error.

## The four layers

Composed in this order, later wins (`dsh-app-boot`, `readProfilePatches`):

| # | Layer | Path | Who writes it |
|---|---|---|---|
| 1 | Bundle | each bundle's own patch files | package upgrades |
| 2 | Profile | `$DSH_HOME/profiles/<name>/cordis.patch.yml` | you, and DSH's own profile init/recovery |
| 3 | **Home** | `$DSH_HOME/cordis.patch.yml` | you only |
| 4 | CLI | `--patch <file>` overlays | you, per invocation |

The home layer outranks every profile layer, and applies to **every** profile.
That makes it the natural home for "I want this everywhere" edits — and the
natural source of cross-profile damage.

## Two patch forms, and only two

```yaml
# Form 1 — replace a named entry's config
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config: { ... }          # replaces the WHOLE config object

# Form 2 — append entries (optionally into a group)
- insert:
    - id: something-new
      name: "@deepseek-ai/some-plugin"
      config: { ... }
```

From the official schema description:

> An insert appends entries, optionally inside the group identified by id. Other
> patches replace supplied fields; **config is replaced wholesale, not
> deep-merged.**

There is no third form. You cannot patch one field of one provider route inside an
existing `config`. To change anything inside a config you must write out the
entire config value you want to win.

Two consequences worth internalising:

- `name:` is an **assertion**, not a rename. If it disagrees with the entry's
  actual name the patch is skipped with a warning.
- An `id` that matches nothing warns and skips. A typo is silent-ish, so check
  the warning output during boot.

## Why the home layer is dangerous

Because it applies to all profiles. Suppose `web` and `email` both declare
`llm-pi-ai` with different routes:

```
web:   providers: { zhichu-huawei: { baseURL: http://10.26.15.53:18080/v1, models: [...] } }
email: providers: { huawei:        { baseURL: http://10.26.15.53:18080/v1, models: [... glm-52 ...] } }
```

A home patch that writes `web`'s provider map to fix `web` will, on the next
`email` boot, replace email's map entirely. Email's `huawei` route — and every
model only it declared, plus its `contextWindow`/`maxTokens` tuning — is gone.
No error. Email just starts serving the wrong route.

This is not hypothetical; it is the exact bug that motivated this skill. The
script `scripts/dsh_capability.py` detects it: it compares each profile's own
patch file against that profile's composed config and reports any route that is
declared but missing.

## Choosing where to put an edit

**Prefer the profile layer** (`profiles/<name>/cordis.patch.yml`) for anything
that is not genuinely identical across profiles. It keeps each profile's config
its own, and the blast radius of a mistake is one profile.

Use the home layer only when the value really is the same everywhere — or when
you have confirmed with `--dump-config` that every profile composes correctly.

Be aware of the tradeoff: the profile layer is not purely yours. DSH rewrites it
on two paths:

- `initProfile` writes an **empty template** when the file is missing:
  `if (!existsSync(patchPath)) writeFileSync(patchPath, PROFILE_PATCH_TEMPLATE)`
- `sanitizeProfile` renames it aside to `cordis.patch.yml.bak-<timestamp>`

These do not fire on a healthy profile, so the profile layer normally survives
upgrades. But they explain the "my edit disappeared" symptom better than upgrades
do: if something removes the file, DSH helpfully recreates it empty and your
changes are gone while the file still looks present and normal. `dsh plugin`
manages only `package.json` and `pnpm-lock.yaml`, so it will not restore your
patch. If an edit vanishes, look for:

- a `cordis.patch.yml.bak-*` sibling (the sanitize path ran)
- an editor swap file such as `.cordis.patch.yml.swp` (an editing session is
  still holding an older buffer, and may write it back)

Neither location is touched by an npm/npx upgrade, because both live under
`$DSH_HOME`, outside the package cache.

## Verifying an edit

The composed dump is ground truth. It runs the same patch algorithm the boot
uses, so it cannot drift from what actually mounts:

```bash
dsh --profile <name> --dump-config | sed -n '/- id: llm-pi-ai/,/^- id: /p'
```

Check your change is present, and check nothing else went missing. Do this for
*every* profile your edit can reach — for a home-layer edit, that is all of them:

```bash
for p in $(ls ~/.dsh/profiles); do
  echo "=== $p ==="
  dsh --profile "$p" --dump-config 2>/dev/null | sed -n '/- id: llm-pi-ai/,/^- id: /p' | head -20
done
```

`--dump-default-config` shows the tree *without* your user layer — useful to see
what the bundles ship before any of your edits.

## Expressions do not rescue you

`!!js` expressions are allowed in patch files, and `ctx.get('profileContext')?.name`
does resolve to the profile name inside them. It is tempting to write a
conditional that only patches one profile:

```yaml
config: !!js "ctx.get('profileContext')?.name === 'web' ? {...} : ???"
```

But there is no good value for the `???` branch. Returning the entry's current
config is impossible — the expression is what *produces* that config, so it reads
its own expression node instead of the profile's value. Returning `{}` erases the
config. An expression can read *another* entry's config (via
`ctx.fiber.entry.ctx.loader.entries()`), which allows a mutation-in-place trick,
but that reaches into Cordis internals and depends on evaluation ordering that
is observed rather than documented. It is not worth the fragility.

## When a patch seems to do nothing

1. Confirm the target `id` exists: `dsh --profile <name> --dump-config | grep 'id: <entry>'`
2. Check for a `name:` mismatch — the patch is skipped when it disagrees.
3. Check a higher layer is not overwriting you; the composed dump shows the winner.
4. Check you repeated the *whole* config. A partial config is not a merge; it
   silently drops everything you omitted.
