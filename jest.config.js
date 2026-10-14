/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  clearMocks: true,
  automock: false,
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'Node16',
          verbatimModuleSyntax: false,
          moduleResolution: 'Node16',
          // Node16 emit is isolated; yarn typecheck checks the full source/tests.
          isolatedModules: true,
        },
      },
    ],
  },
}
