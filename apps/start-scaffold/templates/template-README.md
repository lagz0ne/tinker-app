# Tinker app copies

The small and demo copies come from the actual app source in this workspace.
Use `maintain/template-sync.mjs` to export them into an empty output folder.
It copies files and release dependency specs; it generates no runtime wiring.
It never changes a template checkout, branch, or tag.

Small owns a shell, one page, and telemetry. Demo adds accounts, profiles,
todos, sync, mail, migrations, and local service setup.
Start's runtime is copied under `tinker/`; Core and React stay packages.
`@tinker/start` is the build and host dev dependency.
Read each copied app's README before running it.
