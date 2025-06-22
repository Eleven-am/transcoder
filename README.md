# @eleven-am/transcoder

A high-performance, adaptive HLS (HTTP Live Streaming) transcoding library for Node.js with hardware acceleration support and intelligent client management.

## What is @eleven-am/transcoder?

`@eleven-am/transcoder` is a comprehensive media transcoding solution that converts video files into HLS (HTTP Live Streaming) format for adaptive streaming. Unlike simple transcoding tools, this library provides complete streaming infrastructure that handles real-time video processing, client session management, and resource optimization.

The library takes video files and converts them into segmented streams with multiple quality variants, allowing clients to switch between different resolutions and bitrates based on network conditions. This is the same adaptive streaming technology used by Netflix, YouTube, and major streaming platforms.

Beyond basic transcoding, it implements intelligent client tracking and priority-based processing. When multiple users watch the same content, it optimizes transcoding jobs based on user behavior—prioritizing segments for active viewers while de-prioritizing background processing. This ensures smooth playback even under high load.

The system automatically detects and configures hardware acceleration (NVIDIA CUDA, AMD AMF, Apple VideoToolbox, Intel QuickSync, or Linux VAAPI) to dramatically reduce transcoding times and server resource usage compared to software-only solutions.

Advanced resource management monitors CPU, memory, and disk I/O to dynamically adjust concurrent transcoding jobs. This prevents system overload while maximizing throughput, making it production-ready for serving multiple concurrent streams.

### Enterprise-Grade Distributed Transcoding

For high-scale deployments, the library supports distributed transcoding across multiple nodes sharing the same storage (e.g., Kubernetes pods with CSI volumes). This allows horizontal scaling of transcoding workloads with automatic coordination through Redis, enabling multiple servers to collaborate on transcoding the same video without duplicating work.

## Installation

```bash
npm install @eleven-am/transcoder
```

### Prerequisites

- **FFmpeg**: Required for media processing
- **FFprobe**: Required for media analysis (usually included with FFmpeg)

#### Installing FFmpeg

**Ubuntu/Debian:**
```bash
sudo apt update
sudo apt install ffmpeg
```

**macOS:**
```bash
brew install ffmpeg
```

**Windows:**
Download from [FFmpeg official website](https://ffmpeg.org/download.html)

## Quick Start

```typescript
import { HLSController, TranscodeType } from '@eleven-am/transcoder';
import path from 'path';

// Initialize the controller
const hlsController = new HLSController({
    cacheDirectory: './cache',
    hwAccel: true, // Enable hardware acceleration
    maxSegmentBatchSize: 50,
    config: {
        enableHardwareAccelFallback: true,
        metricsInterval: 30000
    }
});

// Initialize hardware acceleration detection
await hlsController.initialize();

// Get master playlist for a video file
const clientId = 'user-123';
const filePath = '/path/to/your/video.mp4';

try {
    const playlist = await hlsController.getMasterPlaylist(filePath, clientId);
    console.log('Master playlist generated successfully');
    console.log(playlist);
} catch (error) {
    console.error('Failed to generate playlist:', error);
}
```

## API Reference

### HLSController

The main entry point for the transcoding library.

#### Constructor

```typescript
new HLSController(options: HLSManagerOptions)
```

**Options:**
- `cacheDirectory` (string): Directory for storing transcoded segments
- `hwAccel?` (boolean): Enable hardware acceleration detection (default: false)
- `database?` (DatabaseConnector): Custom database connector for metadata storage
- `maxSegmentBatchSize?` (number): Maximum segments to process in one batch (default: 100)
- `videoQualities?` (VideoQualityEnum[]): Available video quality levels
- `audioQualities?` (AudioQualityEnum[]): Available audio quality levels
- `config?` (Partial<StreamConfig>): Advanced stream configuration options
- `distributed?` (DistributedConfig): Configuration for distributed transcoding

#### Stream Configuration

The `config` option accepts a `StreamConfig` object with the following properties:

```typescript
interface StreamConfig {
    disposeTimeout: number;           // Time before disposing unused streams (default: 30min)
    maxEncoderDistance: number;       // Max distance for encoder optimization (default: 60)
    segmentTimeout: number;           // Timeout for segment processing (default: 60s)
    enableHardwareAccelFallback: boolean;  // Enable fallback to software (default: true)
    retryFailedSegments: boolean;     // Retry failed segments (default: true)
    maxRetries: number;               // Maximum retry attempts (default: 3)
    metricsInterval: number;          // Metrics emission interval in ms (default: 30s)
}
```

#### Methods

##### `initialize(): Promise<void>`
Initialize the controller and detect hardware acceleration capabilities.

##### `getMasterPlaylist(filePath: string, clientId: string): Promise<string>`
Generate the master HLS playlist for a media file.

##### `getIndexPlaylist(filePath: string, clientId: string, type: StreamType, quality: string, streamIndex: number): Promise<string>`
Get the index playlist for a specific stream quality.

##### `getSegmentStream(filePath: string, clientId: string, type: StreamType, quality: string, streamIndex: number, segmentNumber: number): Promise<SegmentStream>`
Get a specific segment stream for playback. Returns a `SegmentStream` object containing the stream and size information.

```typescript
interface SegmentStream {
    stream: ReadStream;  // The segment file stream
    size: number;        // Size of the segment in bytes
}
```

##### `generateScreenshot(filePath: string, quality: string, streamIndex: number, time: number): Promise<NodeJS.ReadableStream>`
Generate a screenshot at a specific timestamp.

##### `getVTTSubtitle(filePath: string, streamIndex: number): Promise<string>`
Extract and convert subtitles to WebVTT format as a string.

##### `getVTTSubtitleStream(filePath: string, streamIndex: number): Promise<NodeJS.ReadableStream>`
Extract and convert subtitles to WebVTT format as a stream.

##### `getConvertibleSubtitles(filePath: string): Promise<SubtitleInfo[]>`
Get list of subtitle streams that can be converted to WebVTT.

##### `createMetadata(filePath: string): Promise<void>`
Pre-generate and cache metadata for a media file. Useful for preprocessing files before streaming.

##### `onSessionChange(callback: (session: ClientSession) => void): void`
Listen for client session changes (quality changes, playback status).

##### `onStreamMetrics(callback: (event: StreamMetricsEvent) => void): void`
Listen for comprehensive stream metrics including performance data, hardware acceleration status, and transcoding progress.

## Stream Metrics

The library provides comprehensive metrics through the `onStreamMetrics` callback:

```typescript
interface StreamMetricsEvent {
    streamId: string;
    fileId: string;
    type: StreamType;
    quality: string;
    streamIndex: number;
    
    // Core metrics
    metrics: {
        segmentsProcessed: number;
        segmentsFailed: number;
        averageProcessingTime: number;
        hardwareAccelUsed: boolean;
        fallbacksToSoftware: number;
        totalJobsStarted: number;
        totalJobsCompleted: number;
    };
    
    // Hardware acceleration status
    isUsingHardwareAcceleration: boolean;
    currentAccelerationMethod: string;
    originalAccelerationMethod: string | null;
    hasFallenBackToSoftware: boolean;
    
    // Progress tracking
    totalSegments: number;
    segmentsCompleted: number;
    segmentsPending: number;
    segmentsFailed: number;
    segmentsUnstarted: number;
    
    // Performance data
    currentJobsActive: number;
    averageSegmentDuration: number;
    estimatedTimeRemaining: number | null;
    
    // Timing information
    streamCreatedAt: number;
    lastActivityAt: number;
    metricsGeneratedAt: number;
}
```

## Advanced Usage

### Custom Database Connector

Implement your own metadata storage:

```typescript
import { DatabaseConnector } from '@eleven-am/transcoder';

class CustomDatabaseConnector implements DatabaseConnector {
  async getMetadata(fileId: string): Promise<MediaMetadata> {
    // Your implementation
    // Return metadata from your database
  }
  
  async saveMetadata(fileId: string, metadata: MediaMetadata): Promise<MediaMetadata> {
    // Your implementation
    // Save metadata to your database and return it
    return metadata;
  }
  
  async metadataExists(fileId: string): Promise<{ exists: boolean, fileId: string }> {
    // Your implementation
    // Check if metadata exists and return result with fileId
    return { exists: true, fileId };
  }
}

const hlsController = new HLSController({
  cacheDirectory: './cache',
  database: new CustomDatabaseConnector()
});
```

### Session and Metrics Monitoring

Track client playback sessions and comprehensive stream metrics:

```typescript
// Monitor client sessions
hlsController.onSessionChange((session) => {
  console.log(`Client ${session.clientId}:`);
  console.log(`- File: ${session.filePath}`);
  console.log(`- Status: ${session.status}`); // DIRECT_PLAY, DIRECT_STREAM, or TRANSCODING
  console.log(`- Video: ${session.videoProfile.value} (${session.videoProfile.height}p)`);
  console.log(`- Audio: ${session.audioProfile.value}`);
});

// Monitor stream performance and progress
hlsController.onStreamMetrics((event) => {
  console.log(`Stream ${event.streamId}:`);
  console.log(`- Progress: ${event.segmentsCompleted}/${event.totalSegments} segments`);
  console.log(`- Hardware Accel: ${event.isUsingHardwareAcceleration ? event.currentAccelerationMethod : 'Software'}`);
  console.log(`- Average Processing Time: ${event.metrics.averageProcessingTime}ms`);
  console.log(`- Failed Segments: ${event.segmentsFailed}`);
  
  if (event.estimatedTimeRemaining) {
    console.log(`- ETA: ${Math.round(event.estimatedTimeRemaining / 1000)}s`);
  }
  
  if (event.hasFallenBackToSoftware) {
    console.log(`- Fallback: ${event.originalAccelerationMethod} → software`);
  }
});
```

### Advanced Configuration

```typescript
const hlsController = new HLSController({
  cacheDirectory: './cache',
  hwAccel: true,
  maxSegmentBatchSize: 100,
  config: {
    disposeTimeout: 45 * 60 * 1000,      // 45 minutes
    enableHardwareAccelFallback: true,    // Enable fallback to software
    retryFailedSegments: true,            // Retry failed segments
    maxRetries: 5,                        // Max retry attempts
    metricsInterval: 15000,               // Emit metrics every 15 seconds
    segmentTimeout: 120000,               // 2 minute segment timeout
    maxEncoderDistance: 30                // Optimize for closer segments
  }
});
```

### Distributed Transcoding Configuration

Enable distributed transcoding across multiple servers:

```typescript
const hlsController = new HLSController({
  cacheDirectory: './cache',
  hwAccel: true,
  distributed: {
    enabled: true,                        // Enable distributed mode
    redisUrl: 'redis://localhost:6379',   // Redis connection URL
    workerId: process.env.POD_NAME,       // Unique worker identifier
    claimTTL: 60000,                      // Segment claim TTL (60 seconds)
    claimRenewalInterval: 20000,          // Renew claims every 20 seconds
    segmentTimeout: 30000,                // Timeout for segment completion
    fallbackToLocal: true,                // Fall back to local if Redis unavailable
    completedSegmentTTL: 7 * 24 * 60 * 60 * 1000,  // 7 days
    fileWaitTimeout: 10000                // Wait up to 10s for files on shared storage
  }
});
```

#### Distributed Configuration Options

- `enabled?` (boolean): Enable distributed processing mode
- `redisUrl?` (string): Redis connection URL (can also use REDIS_URL env var)
- `workerId?` (string): Unique identifier for this worker (defaults to hostname)
- `claimTTL?` (number): How long to hold a segment claim in milliseconds (default: 60000)
- `claimRenewalInterval?` (number): How often to renew active claims (default: 20000)
- `segmentTimeout?` (number): Maximum time to wait for segment completion (default: 30000)
- `fallbackToLocal?` (boolean): Fall back to local processing if Redis fails (default: true)
- `completedSegmentTTL?` (number): How long to keep completed segment records (default: 7 days)
- `fileWaitTimeout?` (number): How long to wait for files on shared storage (default: 10000)

#### Kubernetes Deployment Example

```yaml
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
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        volumeMounts:
        - name: shared-storage
          mountPath: /cache
      volumes:
      - name: shared-storage
        persistentVolumeClaim:
          claimName: transcoder-shared-pvc
```

### Preprocessing Media Files

Pre-generate metadata for faster initial playback:

```typescript
// Preprocess files during upload or import
async function preprocessMedia(filePath: string) {
  try {
    await hlsController.createMetadata(filePath);
    console.log('Metadata created and cached');
  } catch (error) {
    console.error('Failed to create metadata:', error);
  }
}
```

### Express.js Integration

```typescript
import express from 'express';
import { HLSController, StreamType } from '@eleven-am/transcoder';

const app = express();
const hlsController = new HLSController({
  cacheDirectory: './cache',
  hwAccel: true,
  config: {
    enableHardwareAccelFallback: true,
    metricsInterval: 30000
  }
});

await hlsController.initialize();

// Master playlist endpoint
app.get('/video/:fileId/playlist.m3u8', async (req, res) => {
  const { fileId } = req.params;
  const clientId = req.headers['x-client-id'] as string;
  const filePath = getFilePathById(fileId); // Your implementation
  
  try {
    const playlist = await hlsController.getMasterPlaylist(filePath, clientId);
    res.set({
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-cache'
    });
    res.send(playlist);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Index playlist endpoint
app.get('/video/:fileId/:type/:index/:quality/playlist.m3u8', async (req, res) => {
  const { fileId, type, index, quality } = req.params;
  const clientId = req.headers['x-client-id'] as string;
  const filePath = getFilePathById(fileId);
  
  const streamType = type === 'video' ? StreamType.VIDEO : StreamType.AUDIO;
  
  try {
    const playlist = await hlsController.getIndexPlaylist(
      filePath, 
      clientId, 
      streamType, 
      quality, 
      parseInt(index)
    );
    
    res.set({
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-cache'
    });
    res.send(playlist);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Segment endpoint
app.get('/video/:fileId/:type/:index/:quality/segment-:segment.ts', async (req, res) => {
  const { fileId, type, index, quality, segment } = req.params;
  const clientId = req.headers['x-client-id'] as string;
  const filePath = getFilePathById(fileId);
  
  const streamType = type === 'video' ? StreamType.VIDEO : StreamType.AUDIO;
  
  try {
    const segmentData = await hlsController.getSegmentStream(
      filePath,
      clientId,
      streamType,
      quality,
      parseInt(index),
      parseInt(segment)
    );
    
    res.set({
      'Content-Type': 'video/mp2t',
      'Content-Length': segmentData.size.toString(),
      'Cache-Control': 'public, max-age=31536000'
    });
    
    segmentData.stream.pipe(res);
  } catch (error) {
    res.status(404).json({ error: 'Segment not found' });
  }
});

// Stream metrics endpoint
app.get('/video/:fileId/metrics', (req, res) => {
  const { fileId } = req.params;
  
  // Set up Server-Sent Events for real-time metrics
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  
  const metricsHandler = (event) => {
    if (event.fileId === fileId) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };
  
  hlsController.onStreamMetrics(metricsHandler);
  
  req.on('close', () => {
    // Clean up listener when client disconnects
    hlsController.removeListener('stream:metrics', metricsHandler);
  });
});
```

## Quality Levels

### Video Qualities
- `240p`: 240px height, ~400kbps average, ~700kbps max
- `360p`: 360px height, ~800kbps average, ~1.4Mbps max
- `480p`: 480px height, ~1.2Mbps average, ~2.1Mbps max
- `720p`: 720px height, ~2.4Mbps average, ~4Mbps max
- `1080p`: 1080px height, ~4.8Mbps average, ~8Mbps max
- `1440p`: 1440px height, ~9.6Mbps average, ~12Mbps max
- `4k`: 2160px height, ~16Mbps average, ~28Mbps max
- `8k`: 4320px height, ~28Mbps average, ~40Mbps max
- `original`: No transcoding, original quality

### Audio Qualities
- `aac`: AAC encoding at 128kbps
- `original`: No transcoding, original codec

## Hardware Acceleration

The library automatically detects and configures hardware acceleration with platform-specific optimization:

### Supported Hardware Acceleration Methods

- **NVIDIA CUDA**: NVIDIA GPUs with NVENC/NVDEC support (Windows, Linux)
- **AMD AMF**: AMD GPUs with Advanced Media Framework (Windows)
- **Apple VideoToolbox**: macOS with Apple Silicon or Intel processors
- **Intel QuickSync (QSV)**: Intel CPUs with integrated graphics (Windows, Linux)
- **VAAPI**: Intel and AMD GPUs on Linux systems

### Detection Priority by Platform

**Windows:**
1. NVIDIA CUDA (if NVIDIA GPU present)
2. AMD AMF (if AMD GPU present)
3. Intel QuickSync (if Intel integrated graphics)
4. Software fallback

**macOS:**
1. Apple VideoToolbox (native acceleration)
2. NVIDIA CUDA (if supported NVIDIA GPU)
3. Software fallback

**Linux:**
1. VAAPI (Intel/AMD GPUs)
2. NVIDIA CUDA (if NVIDIA GPU present)
3. Intel QuickSync
4. Software fallback

### Hardware Acceleration Features

- **Automatic Detection**: Comprehensive testing of each acceleration method
- **Intelligent Fallback**: Automatic fallback to software encoding if hardware fails
- **Error Recovery**: Retry failed segments with different acceleration methods
- **Performance Optimization**: Dynamic adjustment based on hardware capabilities
- **Codec-Specific Optimization**: Optimal decoder selection (especially for CUDA)

Hardware acceleration significantly improves transcoding performance and reduces CPU usage, often providing 5-10x speed improvements over software-only encoding.

## Performance Features

### Intelligent Client Behavior Analysis
- **First-time viewers**: Higher priority for initial segments
- **Sequential playback**: Optimized for continuous viewing
- **Seeking behavior**: Prioritized transcoding for scrubbing

### Dynamic Resource Management
- **Segment Caching**: Transcoded segments cached to disk for reuse
- **Batch Processing**: Multiple segments processed together for efficiency
- **Priority Queuing**: Client behavior affects transcoding priority
- **System Load Balancing**: Automatically adjusts concurrent jobs based on CPU, memory, and I/O
- **Resource Cleanup**: Automatic cleanup of unused streams and old cache files

### Adaptive Processing
- **Dynamic Batch Sizing**: Larger batches with hardware acceleration
- **Load-based Throttling**: Reduces concurrent jobs under high system load
- **Memory Pressure Handling**: Intelligent memory usage monitoring
- **Network-aware Processing**: Adjusts based on client connection patterns

## Error Handling

All methods return standard promises and use try/catch for error handling:

```typescript
try {
    const playlist = await hlsController.getMasterPlaylist(filePath, clientId);
    console.log('Playlist:', playlist);
} catch (error) {
    console.error('Error generating playlist:', error.message);
}

// Handle hardware acceleration fallbacks
hlsController.onStreamMetrics((event) => {
    if (event.hasFallenBackToSoftware) {
        console.warn(`Hardware acceleration failed, using software: ${event.originalAccelerationMethod} → software`);
    }
});
```

## Types Reference

### Core Enums

```typescript
enum StreamType {
    VIDEO = 'v',
    AUDIO = 'a'
}

enum TranscodeType {
    DIRECT_PLAY = 'DIRECT_PLAY',       // No transcoding needed
    DIRECT_STREAM = 'DIRECT_STREAM',   // Container remuxing only
    TRANSCODING = 'TRANSCODING'        // Full transcoding required
}

enum VideoQualityEnum {
    P240 = '240p',
    P360 = '360p',
    P480 = '480p',
    P720 = '720p',
    P1080 = '1080p',
    P1440 = '1440p',
    P4K = '4k',
    P8K = '8k',
    ORIGINAL = 'original'
}

enum AudioQualityEnum {
    AAC = 'aac',
    ORIGINAL = 'original'
}
```

### Key Interfaces

```typescript
interface ClientSession {
    filePath: string;
    clientId: string;
    audioIndex: number;
    videoIndex: number;
    status: TranscodeType;
    audioProfile: AudioQuality;
    videoProfile: VideoQuality;
}

interface SegmentStream {
    stream: ReadStream;  // File stream for the segment
    size: number;        // Size in bytes
}
```

## License

This project is licensed under the GNU General Public License v3.0 - see the [LICENSE](LICENSE) file for details.

Copyright (C) 2025 Roy OSSAI

## Contributing

Contributions are welcome! Please read our contributing guidelines before submitting pull requests.

### Development Scripts

- `npm run ensure-headers` - Automatically adds GPL-3.0 headers to source files
- `npm run build` - Builds the project (automatically ensures GPL headers)
- `npm run lint` - Runs ESLint on the codebase
- `npm test` - Runs the test suite

## Support

For issues and questions, please use the GitHub issue tracker.
