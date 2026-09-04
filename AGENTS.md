# Development Rules

## Package Manager & Tooling

- Strictly use **npm** (`npm install`, `npm run <script>`, `npm test`, etc.) and **npx** (e.g. `npx tsx ...`).
- **NEVER use `pnpm`, `yarn`, or `bun`** to install dependencies, run scripts, or execute ad-hoc commands (e.g. never run `pnpm exec`).
- `@earendil-works/*` dependencies rely on npm's physical package layout for lazy-loaded modules (`*.lazy.js`). Running `pnpm` restructures `node_modules` into an isolated symlinked layout and moves packages into `.ignored/`, causing dynamic imports to fail at runtime.
- Do not add or commit `pnpm-lock.yaml`, `pnpm-workspace.yaml`, or `yarn.lock`.
