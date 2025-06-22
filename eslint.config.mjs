import js from '@eslint/js';
import typescript from '@typescript-eslint/eslint-plugin';
import typescriptParser from '@typescript-eslint/parser';
import importPlugin from 'eslint-plugin-import';

export default [
	{
		ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.d.ts', '*.js', '*.mjs'],
	},
	{
		files: ['src/**/*.ts'],
		languageOptions: {
			parser: typescriptParser,
			parserOptions: {
				project: './tsconfig.json',
				tsconfigRootDir: process.cwd(),
			},
			globals: {
				console: 'readonly',
				process: 'readonly',
				Buffer: 'readonly',
				__dirname: 'readonly',
				__filename: 'readonly',
				exports: 'writable',
				module: 'writable',
				require: 'readonly',
				global: 'readonly',
				Promise: 'readonly',
				NodeJS: 'readonly',
				setTimeout: 'readonly',
				clearTimeout: 'readonly',
				setInterval: 'readonly',
				clearInterval: 'readonly',
			},
		},
		plugins: {
			'@typescript-eslint': typescript,
			'import': importPlugin,
		},
		rules: {
			// Base JavaScript rules
			...js.configs.recommended.rules,
			
			// TypeScript rules
			...typescript.configs.recommended.rules,
			
			// Indentation - use tabs
			'indent': ['error', 'tab', { 'SwitchCase': 1 }],
			'no-tabs': 'off',
			
			// Allow inline comments
			'line-comment-position': 'off',
			'no-inline-comments': 'off',
			
			// Console statements - allow all
			'no-console': 'off',
			
			// TypeScript specific
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-unused-vars': ['warn', { 
				'argsIgnorePattern': '^_',
				'varsIgnorePattern': '^_',
				'caughtErrorsIgnorePattern': '^_',
				'destructuredArrayIgnorePattern': '^_'
			}],
			'@typescript-eslint/no-use-before-define': ['error', { 
				'functions': false,
				'classes': false,
				'variables': true 
			}],
			
			// General rules
			'no-unused-vars': 'off',
			'require-await': 'off', // Turn off - async consistency is more important
			'no-return-await': 'off',
			'callback-return': 'off',
			'guard-for-in': 'off',
			'newline-before-return': 'off',
			
			// Code style
			'quotes': ['error', 'single', { 'avoidEscape': true }],
			'semi': ['error', 'always'],
			'comma-dangle': ['error', 'always-multiline'],
			'object-curly-spacing': ['error', 'always'],
			'array-bracket-spacing': ['error', 'never'],
			'space-before-function-paren': ['error', {
				'anonymous': 'always',
				'named': 'always',
				'asyncArrow': 'always'
			}],
		},
	},
];