/** @type {import('eslint').Linter.Config} */
module.exports = {
    env: {
        node: true,
        es2022: true,
    },
    parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
    },
    extends: ['eslint:recommended'],
    rules: {
        // Style
        'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
        'no-console': 'off', // We use a logger, but console.* is acceptable for boot/legacy code
        'prefer-const': 'warn',
        'no-var': 'error',

        // Safety
        'no-undef': 'error',
        'no-prototype-builtins': 'warn',

        // ESM
        'no-duplicate-imports': 'error',
    },
    ignorePatterns: [
        'node_modules/',
        'dist/',
        'build/',
        '*.cjs', // CJS files (ecosystem.config.cjs, .eslintrc.cjs) can't use ESM rules
    ],
    overrides: [
        {
            // Allow require() in CJS files
            files: ['*.cjs'],
            rules: {
                'no-undef': 'off',
            },
        },
    ],
};
