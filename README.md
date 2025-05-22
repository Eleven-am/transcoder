# @eleven-am/transcoder

A high-performance, adaptive HLS (HTTP Live Streaming) transcoding library for Node.js with hardware acceleration support and intelligent client management.

## What is @eleven-am/transcoder?

`@eleven-am/transcoder` is a comprehensive media transcoding solution that converts video files into HLS (HTTP Live Streaming) format for adaptive streaming. Unlike simple transcoding tools, this library provides complete streaming infrastructure that handles real-time video processing, client session management, and resource optimization.

The library takes video files and converts them into segmented streams with multiple quality variants, allowing clients to switch between different resolutions and bitrates based on network conditions. This is the same adaptive streaming technology used by Netflix, YouTube, and major streaming platforms.

Beyond basic transcoding, it implements intelligent client tracking and priority-based processing. When multiple users watch the same content, it optimizes transcoding jobs based on user behavior—prioritizing segments for active viewers while de-prioritizing background processing. This ensures smooth playback even under high load.

The system automatically detects and configures hardware acceleration (NVIDIA CUDA, Apple VideoToolbox, Intel QuickSync, or Linux VAAPI) to dramatically reduce transcoding times and server resource usage compared to software-only solutions.

Advanced resource management monitors CPU, memory, and disk I/O to dynamically adjust concurrent transcoding jobs. This prevents system overload while maximizing throughput, making it production-ready for serving multiple concurrent streams.

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
    maxSegmentBatchSize: 50
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

#### Methods

##### `initialize(): Promise<void>`
Initialize the controller and detect hardware acceleration capabilities.

##### `getMasterPlaylist(filePath: string, clientId: string): Promise<string>`
Generate the master HLS playlist for a media file.

##### `getIndexPlaylist(filePath: string, clientId: string, type: StreamType, quality: string, streamIndex: number): Promise<string>`
Get the index playlist for a specific stream quality.

##### `getSegmentStream(filePath: string, clientId: string, type: StreamType, quality: string, streamIndex: number, segmentNumber: number): Promise<NodeJS.ReadableStream>`
Get a specific segment stream for playback.

##### `generateScreenshot(filePath: string, quality: string, streamIndex: number, time: number): Promise<NodeJS.ReadableStream>`
Generate a screenshot at a specific timestamp.

##### `getVTTSubtitle(filePath: string, streamIndex: number): Promise<NodeJS.ReadableStream>`
Extract and convert subtitles to WebVTT format.

##### `getConvertibleSubtitles(filePath: string): Promise<SubtitleInfo[]>`
Get list of subtitle streams that can be converted to WebVTT.

##### `onSessionChange(callback: (session: ClientSession) => void): void`
Listen for client session changes (quality changes, playback status).

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

### Session Monitoring

Track client playback sessions and transcoding status:

```typescript
hlsController.onSessionChange((session) => {
  console.log(`Client ${session.clientId}:`);
  console.log(`- File: ${session.filePath}`);
  console.log(`- Status: ${session.status}`); // DIRECT_PLAY, DIRECT_STREAM, or TRANSCODING
  console.log(`- Video: ${session.videoProfile.value} (${session.videoProfile.height}p)`);
  console.log(`- Audio: ${session.audioProfile.value}`);
});
```

### Express.js Integration

```typescript
import express from 'express';
import { HLSController, StreamType } from '@eleven-am/transcoder';

const app = express();
const hlsController = new HLSController({
  cacheDirectory: './cache',
  hwAccel: true
});

await hlsController.initialize();

// Master playlist endpoint
app.get('/video/:fileId/playlist.m3u8', async (req, res) => {
  const { fileId } = req.params;
  const clientId = req.headers['x-client-id'] as string;
  const filePath = getFilePathById(fileId); // Your implementation
  
  try {
    const playlist = await hlsController.getMasterPlaylist(filePath, clientId);
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
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
    
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
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
    const stream = await hlsController.getSegmentStream(
      filePath,
      clientId,
      streamType,
      quality,
      parseInt(index),
      parseInt(segment)
    );
    
    res.set('Content-Type', 'video/mp2t');
    stream.pipe(res);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

## Quality Levels

### Video Qualities
- `240p`: 240px height, ~400kbps
- `360p`: 360px height, ~800kbps
- `480p`: 480px height, ~1.2Mbps
- `720p`: 720px height, ~2.4Mbps
- `1080p`: 1080px height, ~4.8Mbps
- `1440p`: 1440px height, ~9.6Mbps
- `4k`: 2160px height, ~16Mbps
- `8k`: 4320px height, ~28Mbps
- `original`: No transcoding, original quality

### Audio Qualities
- `aac`: AAC encoding at 128kbps
- `original`: No transcoding, original codec

## Hardware Acceleration

The library automatically detects and configures hardware acceleration:

- **NVIDIA CUDA**: Requires NVIDIA GPU with NVENC/NVDEC support
- **Apple VideoToolbox**: Available on macOS with Apple Silicon or Intel
- **Intel QuickSync**: Available on Intel CPUs with integrated graphics
- **VAAPI**: Available on Linux with Intel/AMD GPUs

Hardware acceleration significantly improves transcoding performance and reduces CPU usage.

## Performance Considerations

- **Segment Caching**: Transcoded segments are cached to disk for reuse
- **Batch Processing**: Multiple segments processed together for efficiency
- **Priority System**: Client behavior affects transcoding priority (seeking vs sequential)
- **System Load Balancing**: Automatically adjusts concurrent jobs based on system load
- **Resource Cleanup**: Automatic cleanup of unused streams and old cache files

## Error Handling

All methods return standard promises and use try/catch for error handling:

```typescript
try {
    const playlist = await hlsController.getMasterPlaylist(filePath, clientId);
    console.log('Playlist:', playlist);
} catch (error) {
    console.error('Error generating playlist:', error.message);
}
```

## License

ISC

## Contributing

Contributions are welcome! Please read our contributing guidelines before submitting pull requests.

## Support

For issues and questions, please use the GitHub issue tracker.
