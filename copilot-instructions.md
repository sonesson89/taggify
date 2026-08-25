# Copilot Instructions

## Project Overview
- This repository is a media tagger app with a React + TypeScript client and an Express + TypeScript server.
- The server reads media files from a selected root folder and exposes folder/media/tag APIs.
- The purpose of this project is to browse files in a folder on their own computer. The server is also running locally on the same machine. So the server can read files from the local filesystem and stream them to the client. The client can then display the media files and allow the user to add tags to them.
- Because both client and server are meant to run on the same machine, the server is not exposed to the internet. The client and server communicate over localhost. Therefore, the server does not need to implement any authentication or authorization. The client is trusted to only request files from the local filesystem and to only send valid tag data to the server.

## Workspace Structure
- `client/`: Vite + React UI
- `server/`: Express API and filesystem/media logic
- `outdir/`: default local media folder used when no root is selected

## Development Notes
- Prefer minimal, targeted changes over broad refactors.
- Preserve existing API shapes unless a change is explicitly requested.
- Keep folder path handling safe (no path traversal).
- Keep UI behavior consistent with existing sidebar, pagination, and filtering patterns.

## Style & Conventions
- Use TypeScript strictness-friendly code.
- Keep naming descriptive and consistent with current files.
- Add brief comments only when logic is non-obvious.

## Verification
- Use editor diagnostics for quick checks.
- Run build/tests only when explicitly requested by the user.
- Skip running npm build scripts by default; only run them when explicitly requested by the user.
- Skip running tests after prompts
