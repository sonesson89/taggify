# Taggify

This is an application that can read and manage media files (images, gifs, videos) on your computer. You can use to scan
any directory on your computer and present the files in a browser-based UI where you can manage the files.

In the browser UI you can then add/remove tags to files. Tagging media files will allow you to more easily sort through
a big directory of files, the UI allows you to filter and sort through tags in a dynamic way. This application, unlike other
similar projects, actually stores the tags in the files themselves, as a part of their metadata. It doesn't create any settings
or configuration files.

## How it works

- **Server** (`server/`): an Express + TypeScript API that reads media from a selected root
  folder on your local filesystem and reads/writes tags as file metadata (via `exiftool`).
  Both client and server run locally on your machine — the server is never exposed to the
  internet, and there's no login/auth since it only trusts local requests.
- **Client** (`client/`): a Vite + React UI for browsing folders, filtering by tag/content type,
  and viewing/tagging individual media items in a slideout panel.

## AI tag suggestions

While tagging an item, the app can suggest tags for you using **CLIP**
(`Xenova/clip-vit-base-patch32`), run fully locally via `@xenova/transformers` — no cloud API,
no API key, no per-request cost. Model weights are downloaded once and cached locally, after
which everything runs offline on your CPU.

CLIP maps both images and text into the same vector space, so an image and a tag name can be
compared directly by similarity. Suggestions combine two signals:

1. **Zero-shot matching** — the current image's embedding is compared against embeddings of all
   tag names you've already used elsewhere, surfacing the closest matches.
2. **Neighbor voting (KNN)** — the image is compared against embeddings of your *already-tagged*
   media; the tags of the most visually similar tagged items are suggested, weighted by
   similarity.

This means suggestions can only ever be tags that already exist somewhere in your library — CLIP
re-ranks and matches existing tags, it doesn't invent brand-new tag words.

## Getting started

```
npm run fullstack:dev
```

This starts both the server (`server:dev`) and client (`client:dev`) together. See
`client/README.md` for client-specific details.
