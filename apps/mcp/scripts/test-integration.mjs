import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { execPath } from 'node:process';
import { GenericContainer, Wait } from 'testcontainers';

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const database = 'linearmemory_test';
const username = 'linearmemory';
const password = 'linearmemory-test-only';
const configuredImage = process.env.TESTCONTAINERS_POSTGRES_IMAGE?.trim();

function run(command, args, environment) {
  return new Promise((resolve, reject) => {
    const useNpmCli = command === 'npm' && Boolean(process.env.npm_execpath);
    const executable = useNpmCli ? execPath : command;
    const commandArgs = useNpmCli ? [process.env.npm_execpath, ...args] : args;
    const child = spawn(executable, commandArgs, {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, ...environment },
      stdio: 'inherit'
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}.`)));
  });
}

const image = configuredImage
  ? new GenericContainer(configuredImage)
  : await GenericContainer.fromDockerfile(repositoryRoot, 'docker/postgres/Dockerfile')
      .withCache(true)
      .build('linearmemory/postgres:testcontainers', { deleteOnExit: false });

const container = await image
  .withEnvironment({
    POSTGRES_DB: database,
    POSTGRES_USER: username,
    POSTGRES_PASSWORD: password
  })
  .withCommand([
    'postgres',
    '-c', 'shared_preload_libraries=pg_cron,graph',
    '-c', `cron.database_name=${database}`
  ])
  .withExposedPorts(5432)
  .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/i, 2))
  .withStartupTimeout(180_000)
  .start();

const testEnvironment = {
  PGHOST: container.getHost(),
  PGPORT: String(container.getMappedPort(5432)),
  PGDATABASE: database,
  PGUSER: username,
  PGPASSWORD: password,
  ALLOW_DATABASE_RESTORE_TESTS: '1',
  TESTCONTAINERS_ACTIVE: '1'
};

try {
  await run('npm', ['run', 'migrate:dev'], testEnvironment);
  await run('npm', ['run', 'test:coverage'], testEnvironment);
} finally {
  await container.stop();
}
