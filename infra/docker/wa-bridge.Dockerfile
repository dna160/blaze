# syntax=docker/dockerfile:1
# RentOS WhatsApp bridge (apps/wa-bridge) — whatsmeow linked-device sessions,
# Project Smile's approach. Go, not Node: whatsmeow is the library.
# Build from the repo root: docker build -f infra/docker/wa-bridge.Dockerfile .
# Railway: builder = "DOCKERFILE", dockerfilePath = "infra/docker/wa-bridge.Dockerfile" (see apps/wa-bridge/railway.toml).

FROM golang:1.26-alpine AS builder
WORKDIR /src
COPY apps/wa-bridge/go.mod apps/wa-bridge/go.sum ./
RUN go mod download
COPY apps/wa-bridge/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/wa-bridge .

FROM alpine:3.21 AS runner
RUN apk add --no-cache ca-certificates && addgroup -S rentos && adduser -S rentos -G rentos
COPY --from=builder /out/wa-bridge /usr/local/bin/wa-bridge
USER rentos
ENV PORT=4200
EXPOSE 4200
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4200/healthz || exit 1
CMD ["wa-bridge"]
