import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, execSync, ChildProcess } from 'node:child_process';
import http from 'node:http';
import { NexaError } from '@nexa/shared';
import { validateBrowserUrl } from './safety.js';

export interface ObscuraConfig {
  binaryPath?: string;
  cdpUrl?: string;
  cdpToken?: string;
  port?: number;
  stealth?: boolean;
  allowPrivateNetwork?: boolean;
  startupTimeoutMs?: number;
}

export interface ObscuraHealthResult {
  healthy: boolean;
  wsUrl?: string;
  version?: string;
  error?: string;
}

export class ObscuraManager {
  private config: ObscuraConfig;
  private childProcess: ChildProcess | null = null;
  private port: number;
  private explicitCdpUrl?: string;
  private token?: string;
  private startupTimeoutMs: number;
  private isShuttingDown: boolean = false;

  constructor(config: ObscuraConfig = {}) {
    this.config = config;
    this.port = config.port || (process.env.OBSCURA_PORT ? parseInt(process.env.OBSCURA_PORT, 10) : 9222);
    this.explicitCdpUrl = config.cdpUrl || process.env.OBSCURA_CDP_URL;
    this.token = config.cdpToken || process.env.OBSCURA_CDP_TOKEN;
    this.startupTimeoutMs = config.startupTimeoutMs || 12_000;

    // Graceful process exit cleanup
    const cleanExit = () => {
      this.stopServer().catch(() => {});
    };
    process.once('exit', cleanExit);
    process.once('SIGINT', cleanExit);
    process.once('SIGTERM', cleanExit);
  }

  /**
   * Resolves the absolute path to the Obscura executable on this host.
   */
  public resolveBinaryPath(): string | null {
    if (this.config.binaryPath) {
      try {
        if (fs.existsSync(this.config.binaryPath)) {
          const stats = fs.statSync(this.config.binaryPath);
          if (stats.isFile()) {
            return path.resolve(this.config.binaryPath);
          }
        }
      } catch {}
      return null;
    }

    const candidates = [
      process.env.OBSCURA_BIN_PATH,
      path.join(os.homedir(), '.obscura', 'bin', 'obscura'),
      path.join(process.cwd(), 'bin', 'obscura'),
      path.join(process.cwd(), 'packages', 'browser', 'bin', 'obscura'),
      '/usr/local/bin/obscura',
      '/opt/homebrew/bin/obscura',
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          const stats = fs.statSync(candidate);
          if (stats.isFile()) {
            return path.resolve(candidate);
          }
        }
      } catch {
        // Ignore stat failures and continue search
      }
    }

    // Try PATH lookup via which
    try {
      const whichOutput = execSync('which obscura 2>/dev/null', { encoding: 'utf8' }).trim();
      if (whichOutput && fs.existsSync(whichOutput)) {
        return whichOutput;
      }
    } catch {
      // not in PATH
    }

    return null;
  }

  /**
   * Checks whether the Obscura executable is available on this system.
   */
  public isBinaryAvailable(): boolean {
    return this.resolveBinaryPath() !== null;
  }

  /**
   * Returns the HTTP CDP URL for connecting to Obscura.
   */
  public getCdpUrl(): string {
    if (this.explicitCdpUrl) {
      return this.explicitCdpUrl;
    }
    return `http://127.0.0.1:${this.port}`;
  }

  /**
   * Returns authorization headers if a CDP bearer token is configured.
   */
  public getAuthHeaders(): Record<string, string> | undefined {
    if (this.token) {
      return { Authorization: `Bearer ${this.token}` };
    }
    return undefined;
  }

  /**
   * Performs an HTTP health check against the Obscura CDP /json/version endpoint.
   */
  public async checkHealth(targetUrl = this.getCdpUrl()): Promise<ObscuraHealthResult> {
    return new Promise((resolve) => {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(targetUrl.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://'));
      } catch {
        return resolve({ healthy: false, error: `Invalid CDP URL: ${targetUrl}` });
      }

      const options: http.RequestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: '/json/version',
        method: 'GET',
        timeout: 2000,
        headers: this.getAuthHeaders(),
      };

      const req = http.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const data = JSON.parse(body);
              return resolve({
                healthy: true,
                wsUrl: data.webSocketDebuggerUrl,
                version: data.Browser || 'Obscura',
              });
            } catch {
              return resolve({ healthy: true, version: 'Obscura' });
            }
          }
          return resolve({
            healthy: false,
            error: `Obscura CDP returned status ${res.statusCode}: ${body.slice(0, 200)}`,
          });
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ healthy: false, error: 'Obscura health check timed out (2000ms)' });
      });

      req.on('error', (err) => {
        resolve({ healthy: false, error: err.message });
      });

      req.end();
    });
  }

  /**
   * Starts the Obscura CDP server daemon if not already running,
   * or verifies the existing running endpoint.
   */
  public async startServer(): Promise<string> {
    const cdpUrl = this.getCdpUrl();

    // 1. Check if server is already running and healthy
    const initialHealth = await this.checkHealth(cdpUrl);
    if (initialHealth.healthy) {
      console.log(`[Obscura] existing_cdp_server_active endpoint=${cdpUrl} version="${initialHealth.version || 'unknown'}"`);
      return cdpUrl;
    }

    // If an explicit remote URL was provided but is unreachable, fail clearly
    if (this.explicitCdpUrl) {
      throw new NexaError(`Configured Obscura CDP server at ${this.explicitCdpUrl} is unreachable: ${initialHealth.error}`, {
        code: 'OBSCURA_UNAVAILABLE',
        statusCode: 503,
        userFacingMessage: 'Obscura browser engine is currently unreachable at the configured remote endpoint.',
      });
    }

    // 2. Discover local binary
    const binary = this.resolveBinaryPath();
    if (!binary) {
      throw new NexaError(
        'Obscura browser engine executable not found on this host. Run "pnpm run install:obscura" or set OBSCURA_BIN_PATH.',
        {
          code: 'OBSCURA_UNAVAILABLE',
          statusCode: 503,
          userFacingMessage: 'Obscura browser engine is not installed on this host.',
        }
      );
    }

    // 3. Build arguments
    const args: string[] = ['serve', '--port', this.port.toString()];

    const allowPrivate =
      this.config.allowPrivateNetwork ??
      (process.env.OBSCURA_ALLOW_PRIVATE_NETWORK === '1' ||
        (process.env.NODE_ENV === 'test' && process.env.ALLOW_LOCAL_TEST_HOSTS === 'true'));

    if (allowPrivate) {
      args.push('--allow-private-network');
    }

    const stealth = this.config.stealth ?? process.env.OBSCURA_STEALTH === 'true';
    if (stealth) {
      args.push('--stealth');
    }

    const spawnEnv: NodeJS.ProcessEnv = {
      ...process.env,
    };
    if (this.token) {
      spawnEnv.OBSCURA_CDP_TOKEN = this.token;
    }

    console.log(`[Obscura] launching_process binary="${binary}" port=${this.port} allowPrivate=${allowPrivate} stealth=${stealth}`);

    // 4. Spawn child process
    let processStderr = '';
    const child = spawn(binary, args, {
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.childProcess = child;

    child.stdout?.on('data', (d) => {
      const line = d.toString();
      if (line.includes('listening on') || line.includes('CDP server:')) {
        console.log(`[Obscura] ${line.trim()}`);
      }
    });

    child.stderr?.on('data', (d) => {
      processStderr += d.toString();
    });

    child.on('error', (err) => {
      console.error(`[Obscura] process_error: ${err.message}`);
    });

    child.on('exit', (code, signal) => {
      if (!this.isShuttingDown) {
        console.log(`[Obscura] process_exited code=${code} signal=${signal}`);
      }
      this.childProcess = null;
    });

    // 5. Poll for readiness
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (!this.childProcess || this.childProcess.killed) {
        throw new NexaError(`Obscura process exited prematurely: ${processStderr.trim() || 'unknown error'}`, {
          code: 'OBSCURA_UNAVAILABLE',
          statusCode: 503,
          userFacingMessage: 'Obscura browser daemon failed to start.',
        });
      }

      const health = await this.checkHealth(cdpUrl);
      if (health.healthy) {
        console.log(`[Obscura] daemon_ready endpoint=${cdpUrl} version="${health.version || 'Obscura'}"`);
        return cdpUrl;
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // Startup timed out
    this.stopServer().catch(() => {});
    throw new NexaError(
      `Obscura browser startup timed out after ${this.startupTimeoutMs}ms. Stderr: ${processStderr.trim() || 'none'}`,
      {
        code: 'OBSCURA_UNAVAILABLE',
        statusCode: 503,
        userFacingMessage: 'Obscura browser daemon timed out during startup.',
      }
    );
  }

  /**
   * Stops the child process if one was started by this manager.
   */
  public async stopServer(): Promise<void> {
    this.isShuttingDown = true;
    if (this.childProcess) {
      const cp = this.childProcess;
      this.childProcess = null;
      try {
        cp.kill('SIGTERM');
        // Give 1 second for graceful exit before SIGKILL
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            try {
              cp.kill('SIGKILL');
            } catch {}
            resolve();
          }, 1000);
          cp.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      } catch {
        // Ignore kill errors
      }
    }
  }

  /**
   * Fast CLI extraction of visible page text.
   */
  public async fetchText(
    url: string,
    options: { timeoutMs?: number; allowPrivateNetwork?: boolean } = {}
  ): Promise<string> {
    validateBrowserUrl(url);
    const binary = this.resolveBinaryPath();
    if (!binary) {
      throw new NexaError('Obscura binary not found for CLI fetch.', {
        code: 'OBSCURA_UNAVAILABLE',
      });
    }

    const args = ['fetch', url, '--dump', 'text'];
    if (
      options.allowPrivateNetwork ||
      this.config.allowPrivateNetwork ||
      process.env.OBSCURA_ALLOW_PRIVATE_NETWORK === '1' ||
      (process.env.NODE_ENV === 'test' && process.env.ALLOW_LOCAL_TEST_HOSTS === 'true')
    ) {
      args.push('--allow-private-network');
    }

    return this.execObscuraCommand(binary, args, options.timeoutMs ?? 15_000);
  }

  /**
   * Fast CLI extraction of page content as Markdown.
   */
  public async fetchMarkdown(
    url: string,
    options: { timeoutMs?: number; allowPrivateNetwork?: boolean } = {}
  ): Promise<string> {
    validateBrowserUrl(url);
    const binary = this.resolveBinaryPath();
    if (!binary) {
      throw new NexaError('Obscura binary not found for CLI markdown.', {
        code: 'OBSCURA_UNAVAILABLE',
      });
    }

    const args = ['fetch', url, '--dump', 'markdown'];
    if (
      options.allowPrivateNetwork ||
      this.config.allowPrivateNetwork ||
      process.env.OBSCURA_ALLOW_PRIVATE_NETWORK === '1' ||
      (process.env.NODE_ENV === 'test' && process.env.ALLOW_LOCAL_TEST_HOSTS === 'true')
    ) {
      args.push('--allow-private-network');
    }

    return this.execObscuraCommand(binary, args, options.timeoutMs ?? 15_000);
  }

  /**
   * Fast CLI extraction of hyperlinks on the page.
   */
  public async fetchLinks(
    url: string,
    options: { timeoutMs?: number; allowPrivateNetwork?: boolean } = {}
  ): Promise<Array<{ url: string; text: string }>> {
    validateBrowserUrl(url);
    const binary = this.resolveBinaryPath();
    if (!binary) {
      throw new NexaError('Obscura binary not found for CLI links.', {
        code: 'OBSCURA_UNAVAILABLE',
      });
    }

    const args = ['fetch', url, '--dump', 'links'];
    if (
      options.allowPrivateNetwork ||
      this.config.allowPrivateNetwork ||
      process.env.OBSCURA_ALLOW_PRIVATE_NETWORK === '1' ||
      (process.env.NODE_ENV === 'test' && process.env.ALLOW_LOCAL_TEST_HOSTS === 'true')
    ) {
      args.push('--allow-private-network');
    }

    const raw = await this.execObscuraCommand(binary, args, options.timeoutMs ?? 15_000);
    const links: Array<{ url: string; text: string }> = [];
    const lines = raw.split('\n');
    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length >= 2) {
        const linkUrl = parts[0].trim();
        const linkText = parts.slice(1).join(' ').trim();
        if (linkUrl.startsWith('http://') || linkUrl.startsWith('https://')) {
          links.push({ url: linkUrl, text: linkText });
        }
      }
    }
    return links;
  }

  /**
   * Captures a screenshot of the settled page via Obscura CLI native rendering.
   */
  public async captureCliScreenshot(
    url: string,
    outputPath: string,
    options: { timeoutMs?: number; allowPrivateNetwork?: boolean } = {}
  ): Promise<void> {
    validateBrowserUrl(url);
    const binary = this.resolveBinaryPath();
    if (!binary) {
      throw new NexaError('Obscura binary not found for CLI screenshot.', {
        code: 'OBSCURA_UNAVAILABLE',
      });
    }

    const args = ['fetch', url, '--screenshot', outputPath];
    if (
      options.allowPrivateNetwork ||
      this.config.allowPrivateNetwork ||
      process.env.OBSCURA_ALLOW_PRIVATE_NETWORK === '1' ||
      (process.env.NODE_ENV === 'test' && process.env.ALLOW_LOCAL_TEST_HOSTS === 'true')
    ) {
      args.push('--allow-private-network');
    }

    await this.execObscuraCommand(binary, args, options.timeoutMs ?? 20_000);
  }

  private execObscuraCommand(binary: string, args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let isDone = false;

      const timer = setTimeout(() => {
        if (!isDone) {
          isDone = true;
          child.kill('SIGKILL');
          reject(new NexaError(`Obscura CLI command timed out after ${timeoutMs}ms.`, { code: 'OBSCURA_TIMEOUT' }));
        }
      }, timeoutMs);

      child.stdout?.on('data', (d) => {
        stdout += d.toString();
      });

      child.stderr?.on('data', (d) => {
        stderr += d.toString();
      });

      child.on('close', (code) => {
        if (isDone) return;
        isDone = true;
        clearTimeout(timer);

        if (code === 0) {
          // Filter out header lines such as "Fetching ...", "Page loaded: ..."
          const cleanLines = stdout
            .split('\n')
            .filter((l) => !l.startsWith('Fetching http') && !l.startsWith('Page loaded:'))
            .join('\n')
            .trim();
          resolve(cleanLines);
        } else {
          reject(
            new NexaError(`Obscura CLI failed with code ${code}: ${stderr.trim() || stdout.trim()}`, {
              code: 'OBSCURA_CLI_FAILED',
            })
          );
        }
      });

      child.on('error', (err) => {
        if (isDone) return;
        isDone = true;
        clearTimeout(timer);
        reject(new NexaError(`Obscura process execution error: ${err.message}`, { code: 'OBSCURA_EXEC_ERROR' }));
      });
    });
  }
}
