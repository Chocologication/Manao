"""Manao FastAPI web template: a demo route and a dependency-aware readiness probe."""

from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()


@app.get("/api/demo")
def demo():
    return {"message": "Hello from Manao"}


# MANAO:IF mysql
def _mysql_ready() -> bool:
    import os

    import pymysql

    timeout_seconds = 3
    try:
        connection = pymysql.connect(
            host=os.environ["MANAO_MYSQL_HOST"],
            port=int(os.environ.get("MANAO_MYSQL_PORT", "3306")),
            user=os.environ["MANAO_MYSQL_USERNAME"],
            password=os.environ["MANAO_MYSQL_PASSWORD"],
            database=os.environ["MANAO_MYSQL_DATABASE"],
            connect_timeout=timeout_seconds,
            read_timeout=timeout_seconds,
            write_timeout=timeout_seconds,
        )
    except Exception:
        return False
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            cursor.fetchone()
    except Exception:
        return False
    finally:
        connection.close()
    return True


# MANAO:END mysql
# MANAO:IF redis
def _redis_ready() -> bool:
    import os

    import redis

    timeout_seconds = 3
    try:
        client = redis.Redis(
            host=os.environ["MANAO_REDIS_HOST"],
            port=int(os.environ.get("MANAO_REDIS_PORT", "6379")),
            password=os.environ.get("MANAO_REDIS_PASSWORD") or None,
            socket_connect_timeout=timeout_seconds,
            socket_timeout=timeout_seconds,
        )
        return bool(client.ping())
    except Exception:
        return False


# MANAO:END redis


@app.get("/health/ready")
def ready():
    # MANAO:IF mysql
    if not _mysql_ready():
        return JSONResponse(status_code=503, content={"status": "unready"})
    # MANAO:END mysql
    # MANAO:IF redis
    if not _redis_ready():
        return JSONResponse(status_code=503, content={"status": "unready"})
    # MANAO:END redis
    return {"status": "ready"}
