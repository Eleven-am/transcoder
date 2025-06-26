import {HLSController, StreamType} from '../src';

/**
 * Example: Using @eleven-am/transcoder in distributed mode
 *
 * This example shows how to configure the transcoder to work
 * across multiple Kubernetes pods or Docker containers
 */

async function main() {
    // Example 1: Local mode (default - backward compatible)
    const localController = new HLSController({
        cacheDirectory: '/var/data/hls',
        hwAccel: true,
    });

    await localController.initialize();
    console.log('Local mode initialized');

    // Example 2: Distributed mode with Redis
    const distributedController = new HLSController({
        cacheDirectory: '/shared/hls', // Must be shared storage (NFS, CSI, etc)
        hwAccel: true,
        distributed: {
            enabled: true,
            redisUrl: process.env.REDIS_URL || 'redis://redis:6379',
            workerId: process.env.HOSTNAME, // Kubernetes pod name
            claimTTL: 60000, // 60 second claim timeout
            fallbackToLocal: true, // Fall back if Redis fails
        },
    });

    await distributedController.initialize();
    console.log('Distributed mode initialized');

    // Example 3: Distributed mode with environment detection
    const autoController = new HLSController({
        cacheDirectory: process.env.HLS_CACHE_DIR || '/var/data/hls',
        hwAccel: true,
        distributed: {
            // Will use distributed mode only if REDIS_URL is set
            enabled: Boolean(process.env.REDIS_URL),
            redisUrl: process.env.REDIS_URL,
            // Kubernetes automatically sets HOSTNAME to pod name
            workerId: process.env.HOSTNAME,
        },
    });

    await autoController.initialize();

    // The API remains exactly the same regardless of mode
    const playlist = await autoController.getIndexPlaylist(
        '/media/video.mp4',
        'client-123',
        StreamType.VIDEO,
        '1080p',
        0
    );

    console.log('Playlist generated:', playlist);

    // Cleanup
    await localController.dispose();
    await distributedController.dispose();
    await autoController.dispose();
}

// Kubernetes deployment example
const k8sDeploymentExample = `
apiVersion: v1
kind: ConfigMap
metadata:
  name: transcoder-config
data:
  REDIS_URL: "redis://redis-service:6379"
  HLS_CACHE_DIR: "/shared/hls"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: transcoder
spec:
  replicas: 3
  selector:
    matchLabels:
      app: transcoder
  template:
    metadata:
      labels:
        app: transcoder
    spec:
      containers:
      - name: transcoder
        image: your-registry/transcoder:latest
        envFrom:
        - configMapRef:
            name: transcoder-config
        env:
        - name: HOSTNAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        volumeMounts:
        - name: shared-storage
          mountPath: /shared/hls
      volumes:
      - name: shared-storage
        persistentVolumeClaim:
          claimName: shared-hls-pvc
`;

// Docker Compose example
const dockerComposeExample = `
version: '3.8'

services:
  transcoder-1:
    build: .
    environment:
      - REDIS_URL=redis://redis:6379
      - HLS_CACHE_DIR=/shared/hls
      - HOSTNAME=transcoder-1
    volumes:
      - shared-hls:/shared/hls
    depends_on:
      - redis

  transcoder-2:
    build: .
    environment:
      - REDIS_URL=redis://redis:6379
      - HLS_CACHE_DIR=/shared/hls
      - HOSTNAME=transcoder-2
    volumes:
      - shared-hls:/shared/hls
    depends_on:
      - redis

  transcoder-3:
    build: .
    environment:
      - REDIS_URL=redis://redis:6379
      - HLS_CACHE_DIR=/shared/hls
      - HOSTNAME=transcoder-3
    volumes:
      - shared-hls:/shared/hls
    depends_on:
      - redis

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
    volumes:
      - shared-hls:/usr/share/nginx/html/hls:ro
    depends_on:
      - transcoder-1
      - transcoder-2
      - transcoder-3

volumes:
  shared-hls:
`;

if (require.main === module) {
    main().catch(console.error);
}

export { main };
