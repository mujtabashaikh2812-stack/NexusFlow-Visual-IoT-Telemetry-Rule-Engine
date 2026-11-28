'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');

test('Docker: Dockerfile specifies hardened Alpine Node 22 production container', () => {
  const dockerfile = fs.readFileSync(path.join(rootDir, 'Dockerfile'), 'utf8');

  assert.match(dockerfile, /FROM node:22-alpine/);
  assert.match(dockerfile, /NODE_ENV=production/);
  assert.match(dockerfile, /USER nexusflow/);
  assert.match(dockerfile, /EXPOSE 4000/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /\/healthz/);
  assert.match(dockerfile, /CMD \["node", "src\/server\.js"\]/);
});

test('Docker: docker-compose.yml orchestrates nexusflow-core and MongoDB replica set with healthchecks', () => {
  const compose = fs.readFileSync(path.join(rootDir, 'docker-compose.yml'), 'utf8');

  assert.match(compose, /nexusflow-core:/);
  assert.match(compose, /mongodb:/);
  assert.match(compose, /image:\s*mongo:7\.0/);
  assert.match(compose, /--replSet.*rs0/);
  assert.match(compose, /4000/);
  assert.match(compose, /27017:27017/);
  assert.match(compose, /condition:\s*service_healthy/);
  assert.match(compose, /nexusflow-rules:/);
  assert.match(compose, /mongo-data:/);
  assert.match(compose, /nexusflow-net:/);
});

test('Docker: .dockerignore excludes node_modules, .git, tests, and local secrets', () => {
  const dockerignore = fs.readFileSync(path.join(rootDir, '.dockerignore'), 'utf8');

  assert.match(dockerignore, /node_modules\//);
  assert.match(dockerignore, /\.git\//);
  assert.match(dockerignore, /\.env/);
  assert.match(dockerignore, /tests\//);
});
