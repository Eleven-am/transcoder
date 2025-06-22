# Distributed Transcoding Guide

## Overview

The @eleven-am/transcoder package now supports distributed transcoding across multiple nodes/pods. This enables horizontal scaling of video processing workloads while maintaining backward compatibility with single-node deployments.

## Key Features

- **Automatic Mode Detection**: Detects Redis availability and switches between local and distributed modes
- **Zero Breaking Changes**: Existing single-node deployments continue to work unchanged
- **Segment-Level Distribution**: Each video segment can be processed by different workers
- **Automatic Failover**: Falls back to local processing if Redis becomes unavailable
- **Kubernetes Ready**: Designed for cloud-native deployments

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Transcoder    │     │   Transcoder    │     │   Transcoder    │
│     Pod 1       │     │     Pod 2       │     │     Pod 3       │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         └───────────────────────┴───────────────────────┘
                                 │
                         ┌───────▼────────┐
                         │     Redis      │
                         │ (Coordination) │
                         └───────┬────────┘
                                 │
                         ┌───────▼────────┐
                         │ Shared Storage │
                         │  (NFS/CSI)     │
                         └────────────────┘
```

## Configuration

### Basic Setup

```typescript
const controller = new HLSController({
    cacheDirectory: '/shared/hls', // Must be shared across all nodes
    distributed: {
        enabled: true,
        redisUrl: 'redis://redis:6379',
        workerId: process.env.HOSTNAME,
        claimTTL: 60000, // 60 seconds
        fallbackToLocal: true
    }
});
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | true | Enable distributed mode |
| `redisUrl` | string | - | Redis connection URL |
| `workerId` | string | hostname | Unique worker identifier |
| `claimTTL` | number | 60000 | Segment claim timeout (ms) |
| `fallbackToLocal` | boolean | true | Fall back to local on Redis failure |

## How It Works

### 1. Segment Claiming

When a worker needs to process a segment:
1. It attempts to claim the segment in Redis using atomic operations
2. If successful, it gets an exclusive lock with a TTL
3. If another worker has the claim, it waits for completion

### 2. Processing

The claiming worker:
1. Processes the segment using FFmpeg
2. Writes the output to shared storage
3. Marks the segment as completed in Redis
4. Notifies waiting workers via pub/sub

### 3. Failure Handling

If a worker crashes:
1. Its segment claims expire after the TTL
2. Other workers can reclaim and process the segments
3. No manual intervention required

## Deployment Examples

### Kubernetes

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: shared-hls-pvc
spec:
  accessModes:
    - ReadWriteMany  # Important: Must support multiple writers
  resources:
    requests:
      storage: 100Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: transcoder
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: transcoder
        image: your-app:latest
        env:
        - name: REDIS_URL
          value: "redis://redis-service:6379"
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
```

### Docker Compose

```yaml
version: '3.8'

services:
  transcoder:
    image: your-app:latest
    deploy:
      replicas: 3
    environment:
      - REDIS_URL=redis://redis:6379
    volumes:
      - shared-hls:/shared/hls

  redis:
    image: redis:7-alpine

volumes:
  shared-hls:
    driver: local
    driver_opts:
      type: nfs
      o: addr=nfs-server,vers=4
      device: ":/exports/hls"
```

## Performance Considerations

### 1. Redis Latency
- Keep Redis close to workers (same region/AZ)
- Monitor Redis CPU and memory usage
- Consider Redis clustering for high loads

### 2. Shared Storage
- Use high-performance shared storage (SSD-backed)
- Consider storage IOPS limits
- Monitor write latency

### 3. Segment Size
- Smaller segments = better distribution but more overhead
- Larger segments = less overhead but uneven distribution
- Recommended: 2-10 second segments

## Monitoring

Key metrics to monitor:

1. **Segment Processing Rate**: Segments/second per worker
2. **Claim Conflicts**: How often workers compete for segments
3. **Redis Latency**: Time to claim/release segments
4. **Storage Latency**: Time to write segments
5. **Fallback Rate**: How often Redis fallback occurs

## Troubleshooting

### Workers Not Processing Segments

1. Check Redis connectivity:
   ```bash
   redis-cli -h redis-host ping
   ```

2. Verify shared storage is mounted:
   ```bash
   ls -la /shared/hls
   ```

3. Check worker logs for errors

### Uneven Load Distribution

1. Ensure all workers have similar resources
2. Check for network latency differences
3. Monitor segment claim patterns

### High Fallback Rate

1. Check Redis memory usage
2. Verify Redis persistence settings
3. Monitor network stability

## Best Practices

1. **Use Environment Detection**
   ```typescript
   distributed: {
       enabled: Boolean(process.env.REDIS_URL),
       redisUrl: process.env.REDIS_URL
   }
   ```

2. **Set Appropriate TTLs**
   - Too short: Premature claim expiration
   - Too long: Slow failure recovery
   - Recommended: 2-3x average segment processing time

3. **Monitor Everything**
   - Use the built-in metrics
   - Set up alerts for failures
   - Track processing performance

4. **Test Failure Scenarios**
   - Kill workers during processing
   - Disconnect Redis
   - Fill up storage

## Migration Guide

### From Single-Node to Distributed

1. **No Code Changes Required** - The API remains the same

2. **Infrastructure Setup**:
   - Deploy Redis
   - Set up shared storage
   - Configure environment variables

3. **Gradual Rollout**:
   - Start with one distributed worker
   - Monitor performance
   - Scale up gradually

### Rollback

To rollback to single-node:
1. Remove `REDIS_URL` environment variable
2. The system automatically uses local mode
3. No code changes needed

## Advanced Configuration

### Custom Redis Configuration

```typescript
import { createClient } from 'redis';

const redis = createClient({
    url: 'redis://redis:6379',
    socket: {
        connectTimeout: 5000,
        keepAlive: 5000
    }
});

const controller = new HLSController({
    cacheDirectory: '/shared/hls',
    distributed: {
        enabled: true,
        redisUrl: 'redis://redis:6379',
        // ... other options
    }
});
```

### Multi-Region Setup

For multi-region deployments:
1. Use Redis replication
2. Deploy workers in each region
3. Use region-aware storage
4. Configure region-specific worker IDs

## FAQ

**Q: Can I mix local and distributed workers?**
A: No, all workers should use the same mode to avoid conflicts.

**Q: What happens if Redis goes down?**
A: Workers fall back to local processing if `fallbackToLocal` is true.

**Q: How many workers can I run?**
A: Theoretically unlimited, but practical limit depends on Redis and storage performance.

**Q: Can I use this with serverless?**
A: Not recommended due to cold starts and shared storage requirements.

**Q: Is the output deterministic?**
A: Yes, regardless of which worker processes which segment.