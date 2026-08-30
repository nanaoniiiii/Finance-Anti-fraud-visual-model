FROM python:3.10-slim-bookworm

ARG RKNN_TAG=v2.3.2

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ffmpeg \
       git \
       libgl1 \
       libglib2.0-0 \
       libgomp1 \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch ${RKNN_TAG} \
      https://github.com/airockchip/rknn-toolkit2.git /opt/rknn-toolkit2

RUN python -m pip install --no-cache-dir --upgrade pip \
    && python -m pip install --no-cache-dir \
       --index-url https://download.pytorch.org/whl/cpu \
       torch==2.4.0 torchvision==0.19.0 \
    && python -m pip install --no-cache-dir \
       numpy==1.26.4 \
       ml_dtypes==0.5.1 \
       onnx==1.18.0 \
       onnxruntime==1.22.1 \
       onnxslim==0.1.96 \
       protobuf==4.25.4 \
       ultralytics==8.4.103 \
       -r /opt/rknn-toolkit2/rknn-toolkit2/packages/x86_64/requirements_cp310-2.3.2.txt \
    && python -m pip install --no-cache-dir \
       /opt/rknn-toolkit2/rknn-toolkit2/packages/x86_64/rknn_toolkit2-2.3.2-cp310-cp310-manylinux_2_17_x86_64.manylinux2014_x86_64.whl

ENV PYTHONUNBUFFERED=1
WORKDIR /workspace
