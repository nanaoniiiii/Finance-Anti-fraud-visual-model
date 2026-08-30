FROM debian:bookworm-slim AS native-test

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates \
       cmake \
       file \
       g++ \
       ninja-build \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

FROM debian:bookworm-slim AS rknn-source

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && git clone --depth 1 --branch v2.3.2 \
       https://github.com/airockchip/rknn-toolkit2.git /opt/rknn-toolkit2 \
    && rm -rf /var/lib/apt/lists/*

FROM debian:bookworm-slim AS aarch64-build

RUN dpkg --add-architecture arm64 \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates \
       cmake \
       crossbuild-essential-arm64 \
       file \
       libgstreamer1.0-dev:arm64 \
       libgstreamer-plugins-base1.0-dev:arm64 \
       libjpeg62-turbo-dev:arm64 \
       ninja-build \
       pkg-config \
    && rm -rf /var/lib/apt/lists/*

COPY --from=rknn-source /opt/rknn-toolkit2/rknpu2/runtime/Linux/librknn_api /opt/rknn

ENV RKNN_ROOT=/opt/rknn
ENV PKG_CONFIG_LIBDIR=/usr/lib/aarch64-linux-gnu/pkgconfig:/usr/share/pkgconfig

WORKDIR /workspace
