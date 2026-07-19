
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
    '^.+\\.jsx?$': 'ts-jest',
  },
  transformIgnorePatterns: [
    "node_modules/(?!(@polymarket|@opinion-labs|ethers|@ethersproject|axios|@prob|ky|viem|ox|polymarket-us|@noble)/)"
  ],
  moduleNameMapper: {
    '^@opinion-labs/opinion-clob-sdk$': '<rootDir>/../node_modules/@opinion-labs/opinion-clob-sdk/dist/index.js',
    '^@opinion-labs/opinion-api$': '<rootDir>/../node_modules/@opinion-labs/opinion-api/dist/index.js',
    '^@opinion-labs/opinion-api/client$': '<rootDir>/../node_modules/@opinion-labs/opinion-api/dist/client/index.js',
  },
  testPathIgnorePatterns: ["/node_modules/", "/dist/", "\\.claude/worktrees/agent-"],
};