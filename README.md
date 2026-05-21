# socialaize/actions

Shared composite GitHub Actions used across the Socialaize org.

## Actions

### `Socialaize/actions/sync-fn`

Pushes a function repo's `.fnconfig.yml` to Appwrite. Optionally builds and uploads a deployment tarball.

**Usage** (from a function repo's `.github/workflows/sync-spec.yml`):

```yaml
name: Sync function spec to Appwrite

on:
  push:
    branches: [main]
    paths:
      - .fnconfig.yml
      - .github/workflows/sync-spec.yml
  workflow_dispatch:

concurrency:
  group: sync-spec-${{ github.repository }}
  cancel-in-progress: true

jobs:
  sync:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: Socialaize/actions/sync-fn@main
        with:
          mode: spec
          appwrite-endpoint: ${{ secrets.APPWRITE_ENDPOINT }}
          appwrite-project-id: ${{ secrets.APPWRITE_PROJECT_ID }}
          appwrite-api-key: ${{ secrets.APPWRITE_API_KEY }}
```

**Inputs**

| name | required | default | meaning |
| --- | --- | --- | --- |
| `mode` | no | `spec` | `spec` = metadata-only update from `.fnconfig.yml`; `deploy` = metadata + tarball upload of `$GITHUB_WORKSPACE` |
| `activate` | no | `false` | In `deploy` mode, activate the new deployment immediately |
| `appwrite-endpoint` | yes | — | Appwrite endpoint, e.g. `https://appwrite.socialaize.com/v1` |
| `appwrite-project-id` | yes | — | Appwrite project ID |
| `appwrite-api-key` | yes | — | API key with `functions.write` scope |
| `function-id` | no | from `$id` in `.fnconfig.yml` | Override the Appwrite function ID |
| `fnconfig-path` | no | `.fnconfig.yml` | Path to `.fnconfig.yml` relative to the caller workspace |
