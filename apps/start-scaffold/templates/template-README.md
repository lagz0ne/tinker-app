# Tinker app

Start a new app on `@tinker/start`.
This branch holds no app.
Each other branch is one starting point.
Pick one below.

## Small app

One page, telemetry on, no settings:

```bash
npx degit lagz0ne/tinker-app#small my-app
cd my-app
npm install
npm run dev
```

Source: [`small`](../../tree/small).

## Full demo

Accounts, profiles, todos, live sync, and mail.
It needs Docker for Postgres and Mailpit:

```bash
npx degit lagz0ne/tinker-app#demo my-app
cd my-app
npm run setup
npm run dev
```

`npm run setup` writes `.env` with a new secret.
It starts the local services and installs packages.

Source: [`demo`](../../tree/demo).

Open `http://localhost:4318` when dev starts.

## Pin a release

Each release tags every branch:

- `small-v@VERSION@`
- `demo-v@VERSION@`

Put the tag after `#`:

```bash
npx degit lagz0ne/tinker-app#demo-v@VERSION@ my-app
```

Without Node tools, curl works too:

```bash
mkdir my-app && cd my-app
curl -sL https://codeload.github.com/\
lagz0ne/tinker-app/tar.gz/demo \
  | tar xz --strip-components=1
```

## Make it yours

After degit, push it as your own repo:

```bash
git init && git add -A
git commit -m "Start from tinker-app"
gh repo create my-app --private \
  --source . --push
```

This repo is written by `scripts/template-sync.mjs`
in `lagz0ne/tinkered`.
Do not edit it by hand.
