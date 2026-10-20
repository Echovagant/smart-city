# 智慧城市 3D 可视化平台 —— 单镜像同时提供 API 与前端构建产物。
#
# 本文件在编写环境里**没有经过 Docker 构建验证**（那台机器未安装 Docker）。
# 首次使用请先本地 `docker build -t smart-city .` 验证。
#
# 构建阶段：node 装依赖并产出 dist/（含 Cesium 静态资源）
# 运行阶段：python 运行时托管 API + dist/ 静态文件

# ---------- 构建阶段 ----------
FROM node:22-bookworm-slim AS frontend-builder
WORKDIR /build
COPY Data-driven-modeling/package.json Data-driven-modeling/package-lock.json ./
RUN npm ci --registry=https://registry.npmmirror.com
COPY Data-driven-modeling/ ./
RUN npm run build

# ---------- 运行阶段 ----------
FROM python:3.12-slim
WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY backend-python/requirements.txt backend-python/requirements-dev.txt /app/backend-python/
RUN pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple \
    -r /app/backend-python/requirements.txt -r /app/backend-python/requirements-dev.txt

COPY backend-python/ /app/backend-python/
COPY --from=frontend-builder /build/dist /app/Data-driven-modeling/dist

WORKDIR /app/backend-python
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
