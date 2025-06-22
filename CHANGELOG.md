# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Distributed transcoding support for Kubernetes deployments
- Redis-based coordination for multi-node processing
- Automatic fallback from distributed to local mode
- Configurable TTLs and timeouts for distributed processing
- Worker ID-based temp files to prevent collisions
- Atomic file rename operations for race condition prevention
- GitHub Actions workflows for CI/CD and NPM publishing

### Fixed
- Async promise executor anti-pattern in waitForSegmentCompletion
- Synchronous file operations replaced with async versions
- Singleton concurrency issues in SegmentProcessorFactory
- Resource leaks with renewal timers
- Redis client leaks in subscription handling
- Type safety improvements in error handling

### Changed
- Improved error logging and handling throughout
- Better resource cleanup with try/finally blocks
- Enhanced documentation with distributed transcoding examples
- Modernized package.json structure

## [0.0.47] - 2024-12-22

### Added
- Initial distributed backend support with Redis
- Local and distributed segment processor implementations
- Segment claim management system
- Factory pattern for processor creation

## [0.0.46] - 2024-12-21

### Added
- Hardware acceleration support for multiple platforms
- Client tracking and priority-based processing
- Intelligent resource management
- Stream metrics and monitoring

## [0.0.45] - 2024-12-20

### Added
- Initial HLS transcoding implementation
- Basic segment processing
- Quality level support
- FFmpeg integration

[Unreleased]: https://github.com/eleven-am/transcoder/compare/v0.0.47...HEAD
[0.0.47]: https://github.com/eleven-am/transcoder/compare/v0.0.46...v0.0.47
[0.0.46]: https://github.com/eleven-am/transcoder/compare/v0.0.45...v0.0.46
[0.0.45]: https://github.com/eleven-am/transcoder/releases/tag/v0.0.45