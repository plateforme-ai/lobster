# Patch Maintenance

This fork tracks `openclaw/lobster` with a small `patch` branch for local fixes until they are merged upstream.

## Branches

- `main`: clean mirror of `openclaw/lobster`
- `patch`: local changes applied on top of `main`

Do not commit custom changes to `main`.

## Remotes

Check remotes:

```powershell
git remote -v
```

Expected:

```text
origin   https://github.com/plateforme-ai/lobster.git
upstream https://github.com/openclaw/lobster.git
```

Add upstream if missing:

```powershell
git remote add upstream https://github.com/openclaw/lobster.git
```

## Patch

Create `patch` branch if missing:

```powershell
git checkout main
git checkout -b patch
git push -u origin patch
```

Edit files and commit:

```powershell
git checkout patch
git status
git add .
git commit -m "..."
git push origin patch
```

## Sync with Upstream

Update clean `main`:

```powershell
git checkout main
git fetch upstream
git pull --ff-only upstream main
git push origin main
```

Rebase `patch` on top of updated `main`:

```powershell
git checkout patch
git rebase main
```

If there are conflicts, resolve them, then:

```powershell
git add .
git rebase --continue
```

Push the rebased patch branch:

```powershell
git push origin patch --force-with-lease
```

## Testing

Install directly from the patch branch:

```powershell
npm install -g github:plateforme-ai/lobster#patch
```

Verify:

```powershell
lobster --version
```

From an OpenClaw workspace:

```powershell
lobster.cmd 'llm.invoke --prompt "Say hello in one short sentence."'
```

Expected: no `invalid response envelope` error.

Also test the lower-level supported tool path:

```yaml
name: test-llm-task
steps:
  - id: llm
    pipeline: >
      openclaw.invoke --tool llm-task --action json --args-json '{"prompt":"Say hello in one short sentence."}'
```

Run:

```powershell
lobster.cmd run --file test-llm-task.lobster
```

## Publish

Ensure publishing is scoped in `package.json`:

```json
{
  "name": "@plateforme-ai/lobster"
}
```

Login to npm:

```powershell
npm login
npm whoami
```

Bump version and publish:

```powershell
npm version yyyy.mm.dd-x
npm publish --access public
```

## Install

Install published package:

```powershell
npm install -g @plateforme-ai/lobster
```
