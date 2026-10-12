# Manao FastAPI web project

This project was created by the Manao workspace with a fixed Python 3.13 + uv FastAPI template.

Run the editor's Run action to start `uvicorn app.main:app` on the project's primary port.

## Routes

- `GET /api/demo` returns a fixed welcome message.
- `GET /health/ready` reports readiness. Without selected dependencies it always answers 200.
  With MySQL or Redis selected it probes only the selected service with a bounded timeout,
  answers a fixed 503 when the probe fails, never creates data and never reports connection
  details.

## Dependencies

`fastapi` and `uvicorn` are base dependencies. The MySQL and Redis clients are named extras in
`pyproject.toml` (`mysql` is the PyMySQL client with the `rsa` extra, `redis` is the redis
client); the project selection decides which extras are installed into the run environment.
Both live in one `uv.lock` managed by uv; do not edit `uv.lock` by hand.

## Injected environment

- MySQL (when selected): `MANAO_MYSQL_HOST`, `MANAO_MYSQL_PORT`, `MANAO_MYSQL_DATABASE`,
  `MANAO_MYSQL_USERNAME`, `MANAO_MYSQL_PASSWORD`.
- Redis (when selected): `MANAO_REDIS_HOST`, `MANAO_REDIS_PORT`, `MANAO_REDIS_PASSWORD`.
