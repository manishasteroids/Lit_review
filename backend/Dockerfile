# Backend container for Cloud Run. Put this at backend/Dockerfile.
FROM python:3.12-slim

# System deps some wheels need (psycopg, pypdf, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential libpq-dev && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Cloud Run injects $PORT (defaults to 8080). ONE worker: the run state and
# streaming are single-process. Scale with instances, not workers.
ENV PORT=8080
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT} --workers 1"]
