# Taggify client

React + TypeScript + Vite UI for browsing a local media folder and tagging files. See the
[root README](../README.md) for the overall project overview.

## Scripts

- `npm run dev` — start the Vite dev server (used by `fullstack:dev` at the repo root)
- `npm run build` — type-check and build for production
- `npm run lint` — run ESLint
- `npm run preview` — preview a production build locally

## Structure

- `src/App.tsx` — top-level state and data-fetching (folders, media, tags, filters)
- `src/components/` — UI components (folder navigation, media grid, tag slideout, all-tags word
  cloud, etc.)
- `src/api/` — fetch wrappers for the server's REST API
