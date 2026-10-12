# Tinker app

A new app on `@tinker/start`.
Each branch is one starting point.
Each tag pins one of them to a release.

## Start

The small app needs no settings:

```bash
npx degit lagz0ne/tinker-app my-app
cd my-app
npm install
npm run dev
```

The full demo has accounts, profiles, and todos.
It needs Docker for Postgres and Mailpit:

```bash
npx degit lagz0ne/tinker-app#demo my-app
cd my-app
npm run setup
npm run dev
```

`npm run setup` writes `.env` with a new secret.
It starts the local services and installs packages.

Open `http://localhost:4318`.

## Pick a branch or a tag

- `main`: the small app.
- `demo`: the full demo.
- `small-v0.8.0`, `demo-v0.8.0`: one release, pinned.

Put the name after `#`:

```bash
npx degit lagz0ne/tinker-app#demo-v0.8.0 my-app
```

Without Node tools, curl works too:

```bash
mkdir my-app && cd my-app
curl -sL https://codeload.github.com/\
lagz0ne/tinker-app/tar.gz/demo \
  | tar xz --strip-components=1
```

## Make it yours

Click "Use this template" on GitHub for a repo of your own.
It copies the `main` branch.
For another branch, use degit, then push:

```bash
git init && git add -A
git commit -m "Start from tinker-app"
gh repo create my-app --private \
  --source . --push
```

This repo is written by `scripts/template-sync.mjs`
in `lagz0ne/tinkered`.
Do not edit it by hand.
