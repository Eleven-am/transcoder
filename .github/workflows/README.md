# GitHub Actions Workflows

This directory contains automated workflows for CI/CD and package management.

## Workflows

### CI (`ci.yml`)
- **Trigger**: Push to main/develop branches and pull requests
- **Purpose**: Run tests, linting, and build verification across multiple OS and Node versions
- **Matrix**: Ubuntu, macOS, Windows with Node 18.x, 20.x, 22.x
- **Features**:
  - Installs FFmpeg on all platforms
  - Runs full test suite with coverage
  - Uploads coverage to Codecov
  - Validates build process

### Publish (`publish.yml`)
- **Trigger**: GitHub releases or manual workflow dispatch
- **Purpose**: Publish package to NPM registry
- **Features**:
  - Manual version bumping (patch/minor/major)
  - Custom NPM tags (latest/beta/next)
  - Automatic git tagging
  - GitHub release creation
  - Full test suite validation before publish

### Release (`release.yml`)
- **Trigger**: Push to main branch with version changes
- **Purpose**: Automatically create GitHub releases when version is bumped
- **Features**:
  - Detects version changes in package.json
  - Creates GitHub release with changelog link
  - Skips if commit message contains [skip ci]

### Dependabot Auto-Merge (`dependabot.yml`)
- **Trigger**: Dependabot pull requests
- **Purpose**: Automatically merge minor dependency updates
- **Features**:
  - Runs tests before merging
  - Only merges minor/patch updates
  - Requires all tests to pass

## Secrets Required

- `NPM_TOKEN`: NPM authentication token for publishing
- `GITHUB_TOKEN`: Automatically provided by GitHub Actions
- `CODECOV_TOKEN`: (Optional) For enhanced Codecov integration

## Manual Publishing

To manually publish a new version:

1. Go to Actions tab
2. Select "Publish to NPM" workflow
3. Click "Run workflow"
4. Choose version type (patch/minor/major) and tag
5. The workflow will handle version bumping, tagging, and publishing

## Local Development

To test workflows locally, you can use [act](https://github.com/nektos/act):

```bash
# Test CI workflow
act -j test

# Test with specific Node version
act -j test -e NODE_VERSION=20.x
```