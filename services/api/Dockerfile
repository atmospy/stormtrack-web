# Build from services/api:  docker build -t stormtrack-api .
# stormtrack is not on PyPI yet: pass a git URL, e.g.
#   --build-arg STORMTRACK_SPEC="stormtrack[xarray] @ git+https://github.com/atmospy/stormtrack.git"
FROM python:3.12-slim
ARG STORMTRACK_SPEC="stormtrack[xarray]"
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
# install deps explicitly (pyproject's [tool.uv.sources] path is for local dev only)
RUN pip install "fastapi>=0.110" "uvicorn[standard]>=0.29" pandas numpy pyarrow "${STORMTRACK_SPEC}" && pip install --no-deps .
RUN useradd -m app
USER app
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request,os;urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8080')+'/healthz')"
CMD ["sh", "-c", "uvicorn stormtrack_api.app:app --host 0.0.0.0 --port ${PORT:-8080}"]
