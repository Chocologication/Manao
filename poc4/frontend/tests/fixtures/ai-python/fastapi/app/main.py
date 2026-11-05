"""Keep the readiness contract while the business response is broken."""

from fastapi import FastAPI

app = FastAPI()


@app.get("/health/ready")
def ready():
    return {"status": "ready"}


@app.get("/api/demo")
def demo():
    return {"message": "Hello from Manao", "total": "1,001"}
