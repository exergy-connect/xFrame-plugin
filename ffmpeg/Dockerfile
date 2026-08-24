# WASM build of the latest FFmpeg release for WebM → H.264/AAC MP4.
# CLI requires pthreads since FFmpeg 6.1; encode with -threads 1 at runtime.

FROM emscripten/emsdk:6.0.7 AS builder

ENV INSTALL_DIR=/opt
ENV FFMPEG_VERSION=n9.0.1
ENV CFLAGS="-I${INSTALL_DIR}/include -pthread -Os"
ENV CXXFLAGS="${CFLAGS}"
ENV LDFLAGS="-L${INSTALL_DIR}/lib -pthread"
ENV EM_PKG_CONFIG_PATH=${INSTALL_DIR}/lib/pkgconfig
ENV PKG_CONFIG_PATH=${EM_PKG_CONFIG_PATH}

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      pkg-config autoconf automake libtool git yasm nasm ca-certificates gzip && \
    rm -rf /var/lib/apt/lists/*

# --- x264 (8-bit 4:2:0 only; no CLI) ---
WORKDIR /src/x264
RUN git clone --depth 1 https://github.com/ffmpegwasm/x264.git . && \
    emconfigure ./configure \
      --prefix=${INSTALL_DIR} \
      --host=x86-gnu \
      --enable-static \
      --disable-cli \
      --disable-asm \
      --disable-opencl \
      --disable-interlaced \
      --bit-depth=8 \
      --chroma-format=420 \
      --extra-cflags="${CFLAGS}" \
      --disable-thread && \
    emmake make install-lib-static -j$(nproc)

# --- FFmpeg: disable everything, then enable only WebM→MP4 pieces ---
WORKDIR /src/ffmpeg
RUN git clone --depth 1 --branch ${FFMPEG_VERSION} https://github.com/FFmpeg/FFmpeg.git .

RUN emconfigure ./configure \
      --prefix=${INSTALL_DIR} \
      --target-os=none \
      --arch=x86_32 \
      --enable-cross-compile \
      --disable-asm \
      --disable-programs \
      --disable-doc \
      --disable-debug \
      --disable-runtime-cpudetect \
      --disable-autodetect \
      --disable-network \
      --enable-pthreads \
      --disable-w32threads \
      --disable-os2threads \
      --disable-avdevice \
      --disable-swscale-alpha \
      --enable-small \
      --nm=emnm \
      --ar=emar \
      --ranlib=emranlib \
      --cc=emcc \
      --cxx=em++ \
      --objcc=emcc \
      --dep-cc=emcc \
      --extra-cflags="${CFLAGS}" \
      --extra-cxxflags="${CXXFLAGS}" \
      --extra-ldflags="${LDFLAGS}" \
      --disable-everything \
      --enable-gpl \
      --enable-libx264 \
      --enable-avcodec \
      --enable-avformat \
      --enable-avfilter \
      --enable-swscale \
      --enable-swresample \
      --enable-protocol=file \
      --enable-demuxer=matroska \
      --enable-muxer=mp4 \
      --enable-parser=vp8,vp9,opus,aac \
      --enable-bsf=aac_adtstoasc,extract_extradata,vp9_superframe_split \
      --enable-decoder=vp8,vp9,opus,aac \
      --enable-encoder=libx264,aac \
      --enable-filter=scale,fps,format,null,aresample,aformat,anull && \
    emmake make -j$(nproc)

# Build fftools resource objects (graph HTML/CSS) the same way the FFmpeg
# Makefile does when linking the ffmpeg CLI.
RUN emmake make -j$(nproc) \
      ffbuild/bin2c \
      fftools/resources/graph.html.o \
      fftools/resources/graph.css.o \
      fftools/resources/resman.o

# --- Link WASM (fftools set from FFmpeg n9 fftools/Makefile) ---
# No SDL (headless). -Os + LTO for size; fixed memory (pthread cannot grow).
# FFmpeg's CLI pipeline still uses pthreads for demux/decode/filter/mux even
# with encoder -threads 1. Preload enough workers to avoid synchronous
# pthread_create/join deadlocks, and fail explicitly if this pool is exhausted.
RUN mkdir -p /src/dist && \
    emcc ${LDFLAGS} -Os -flto -msimd128 -pthread \
      -I. -I./fftools -I./compat/stdbit -I${INSTALL_DIR}/include \
      -L${INSTALL_DIR}/lib \
      -Llibavcodec -Llibavfilter -Llibavformat -Llibavutil -Llibswresample -Llibswscale \
      -Wno-deprecated-declarations \
      fftools/cmdutils.c \
      fftools/ffmpeg.c \
      fftools/ffmpeg_dec.c \
      fftools/ffmpeg_demux.c \
      fftools/ffmpeg_enc.c \
      fftools/ffmpeg_filter.c \
      fftools/ffmpeg_hw.c \
      fftools/ffmpeg_mux.c \
      fftools/ffmpeg_mux_init.c \
      fftools/ffmpeg_opt.c \
      fftools/ffmpeg_sched.c \
      fftools/opt_common.c \
      fftools/sync_queue.c \
      fftools/thread_queue.c \
      fftools/graph/graphprint.c \
      fftools/textformat/avtextformat.c \
      fftools/textformat/tf_compact.c \
      fftools/textformat/tf_default.c \
      fftools/textformat/tf_flat.c \
      fftools/textformat/tf_ini.c \
      fftools/textformat/tf_json.c \
      fftools/textformat/tf_mermaid.c \
      fftools/textformat/tf_xml.c \
      fftools/textformat/tw_avio.c \
      fftools/textformat/tw_buffer.c \
      fftools/textformat/tw_stdout.c \
      fftools/resources/resman.o \
      fftools/resources/graph.html.o \
      fftools/resources/graph.css.o \
      -lavfilter -lavformat -lavcodec -lswresample -lswscale -lavutil -lx264 -lm \
      -s PTHREAD_POOL_SIZE=8 \
      -s PTHREAD_POOL_SIZE_STRICT=2 \
      -s ENVIRONMENT=worker \
      -s WASM_BIGINT=1 \
      -s STACK_SIZE=2MB \
      -s MODULARIZE=1 \
      -s INITIAL_MEMORY=512MB \
      -s ALLOW_MEMORY_GROWTH=0 \
      -s ASSERTIONS=0 \
      -s EXPORT_NAME=createFFmpegCore \
      -s INVOKE_RUN=0 \
      -s EXPORTED_FUNCTIONS='["_main"]' \
      -s EXPORTED_RUNTIME_METHODS='["FS","callMain"]' \
      -o /src/dist/ffmpeg-to_mp4.js

FROM scratch AS export
COPY --from=builder /src/dist/ /
