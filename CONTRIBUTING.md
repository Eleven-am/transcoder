# Contributing to @eleven-am/transcoder

First off, thank you for considering contributing to @eleven-am/transcoder! It's people like you that make this library better for everyone.

## Code of Conduct

By participating in this project, you are expected to uphold our Code of Conduct:
- Use welcoming and inclusive language
- Be respectful of differing viewpoints and experiences
- Gracefully accept constructive criticism
- Focus on what is best for the community
- Show empathy towards other community members

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check existing issues as you might find out that you don't need to create one. When you are creating a bug report, please include as many details as possible:

- **Use a clear and descriptive title**
- **Describe the exact steps which reproduce the problem**
- **Provide specific examples to demonstrate the steps**
- **Describe the behavior you observed after following the steps**
- **Explain which behavior you expected to see instead and why**
- **Include details about your configuration and environment**

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. When creating an enhancement suggestion, please include:

- **Use a clear and descriptive title**
- **Provide a step-by-step description of the suggested enhancement**
- **Provide specific examples to demonstrate the steps**
- **Describe the current behavior and explain which behavior you expected to see instead**
- **Explain why this enhancement would be useful**

### Pull Requests

1. Fork the repo and create your branch from `main`
2. If you've added code that should be tested, add tests
3. If you've changed APIs, update the documentation
4. Ensure the test suite passes
5. Make sure your code lints
6. Issue that pull request!

## Development Setup

1. Fork and clone the repository
```bash
git clone https://github.com/your-username/transcoder.git
cd transcoder
```

2. Install dependencies
```bash
npm install
```

3. Install FFmpeg (required for tests)
```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt update && sudo apt install ffmpeg

# Windows
choco install ffmpeg
```

4. Run tests
```bash
npm test
```

5. Build the project
```bash
npm run build
```

## Styleguides

### Git Commit Messages

- Use the present tense ("Add feature" not "Added feature")
- Use the imperative mood ("Move cursor to..." not "Moves cursor to...")
- Limit the first line to 72 characters or less
- Reference issues and pull requests liberally after the first line
- Consider starting the commit message with an applicable emoji:
  - 🎨 `:art:` when improving the format/structure of the code
  - 🐎 `:racehorse:` when improving performance
  - 📝 `:memo:` when writing docs
  - 🐛 `:bug:` when fixing a bug
  - 🔥 `:fire:` when removing code or files
  - ✅ `:white_check_mark:` when adding tests
  - 🔒 `:lock:` when dealing with security
  - ⬆️ `:arrow_up:` when upgrading dependencies
  - ⬇️ `:arrow_down:` when downgrading dependencies

### TypeScript Styleguide

- Use TypeScript for all new code
- Follow the existing code style (enforced by ESLint)
- Use meaningful variable names
- Add JSDoc comments for public APIs
- Prefer `const` over `let` when possible
- Use async/await over promises when possible
- Avoid `any` types - use `unknown` or proper types

### Testing

- Write tests for all new features
- Maintain or improve code coverage
- Use descriptive test names
- Test edge cases and error conditions
- Mock external dependencies appropriately

## Project Structure

```
src/
├── distributed/        # Distributed processing components
├── ffmpeg.ts          # FFmpeg wrapper
├── types.ts           # TypeScript type definitions
├── hlsController.ts   # Main controller
├── stream.ts          # Stream processing
└── ...               # Other core components
```

## Release Process

Releases are automated through GitHub Actions when the version in package.json is updated:

1. Update version: `npm version patch/minor/major`
2. Push to main branch
3. GitHub Actions will automatically:
   - Run tests
   - Build the project
   - Create a GitHub release
   - Publish to NPM

## License

By contributing to @eleven-am/transcoder, you agree that your contributions will be licensed under the GNU General Public License v3.0.

## Questions?

Feel free to open an issue with your question or reach out to the maintainers.

Thank you for contributing! 🎉