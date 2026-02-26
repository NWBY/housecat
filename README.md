# Housecat

Housecat is a local-first ClickHouse viewer built with Tauri (Rust backend) and React + TypeScript (Bun frontend).

It gives you a desktop-style DB workflow:

- connect with ClickHouse credentials
- browse schemas and tables in a collapsible explorer
- open multiple table tabs
- open query tabs and run SQL
- save named connections for quick reuse

## Stack

- Frontend: Bun, Vite, React, TypeScript
- UI: Kumo (`@cloudflare/kumo`)
- Backend: Tauri v2 + Rust
- Data access: ClickHouse HTTP API from Rust (`reqwest`)

## Requirements

- Bun
- Rust toolchain
- Tauri prerequisites for your OS: https://tauri.app/start/prerequisites/

## Development

Install dependencies:

```bash
bun install
```

Run the desktop app in development:

```bash
bunx tauri dev
```

Build frontend only:

```bash
bun run build
```

Check Rust backend:

```bash
cd src-tauri && cargo check
```

## Using Housecat

1. Fill in connection settings on the Connection screen.
2. Optionally set a connection name and click `Save Connection`.
3. Click `Open Viewer`.
4. In Viewer:
   - click tables in the explorer to open new table tabs
   - click `+` to create a new query tab
   - run SQL from query tabs

Saved connections can be loaded or connected directly from the Connection screen.

## ClickHouse Notes

- Housecat connects over the ClickHouse HTTP interface (`http`/`https`), not native TCP.
- Typical ports:
  - `8123` for HTTP
  - `8443` for HTTPS (if configured)

## Project Structure

- `src/` - React UI
- `src-tauri/` - Tauri + Rust commands

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/)
- [Tauri extension](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode)
- [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
