# protoWorkstacean Docs Site

Nextra-based static documentation site, deployed to GitHub Pages at `/protoWorkstacean`.

## Development

```bash
cd docs-site
npm install
npm run link     # symlinks ../docs → content (run once)
npm run dev      # http://localhost:3000/protoWorkstacean
```

## Build

```bash
npm run build    # outputs to docs-site/out/
```

## Deployment

Deployed automatically via `.github/workflows/docs-deploy.yml` on every push to `main` that touches `docs/**` or `docs-site/**`.

## Structure

Content lives in `../docs/` (symlinked as `content/`). The Diataxis sections map to:

| Directory | Diataxis type |
|---|---|
| `docs/tutorials/` | Learning-oriented walkthroughs |
| `docs/guides/` | Task-oriented how-tos |
| `docs/reference/` | Exact specs and schemas |
| `docs/explanation/` | Conceptual architecture docs |
| `docs/contributing/` | Contributor guides |

Navigation order is controlled by `_meta.ts` files in each directory.
